import http from "node:http";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, createHmac, timingSafeEqual, randomUUID } from "node:crypto";
import { createFileStore } from "./store.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const env = { ...process.env };
try {
  const dotenv = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", ".env"), "utf8");
  dotenv.split(/\r?\n/).forEach((line) => {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    // Only fill in a variable that's entirely absent from process.env — an
    // explicitly set empty string (e.g. tests forcing AI_API_KEY="" so they
    // never hit a real provider) must NOT be overwritten by .env's value.
    if (match && env[match[1]] === undefined) env[match[1]] = match[2];
  });
} catch {}
const config = {
  host: env.HOST || "127.0.0.1",
  port: Number(env.PORT || 8787),
  // Deploys may inject a commit SHA/revision so a cloud endpoint cannot look
  // current merely because its semantic version still matches the checkout.
  buildId: env.TIMEW_BUILD_ID || env.DENO_DEPLOYMENT_ID || env.GIT_SHA || "local",
  token: env.DEVICE_TOKEN || "",
  dataDir: env.DATA_DIR ? resolveDataDir(env.DATA_DIR) : join(ROOT, "..", "data"),
  provider: env.AI_PROVIDER || "mock",
  apiKey: env.AI_API_KEY || "",
  baseUrl: (env.AI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, ""),
  model: env.AI_MODEL || "gpt-4o-mini",
  transcribeModel: env.TRANSCRIBE_MODEL || "whisper-1",
  geminiModel: env.GEMINI_MODEL || "gemini-3.6-flash",
  maxAudioBytes: Number(env.MAX_AUDIO_BYTES || 1048576),
  providerTimeoutMs: Number(env.AI_TIMEOUT_MS || 20000),
  rateLimitMax: Number(env.RATE_LIMIT_MAX || 120),
  rateLimitWindowMs: Number(env.RATE_LIMIT_WINDOW_MS || 60000),
  logRequests: !["0", "false"].includes(String(env.LOG_REQUESTS || "").toLowerCase()),
  // Base URL for the Gemini API. Overridable only so tests can point it at a
  // local mock HTTP server instead of the real Google endpoint; the gateway
  // itself never needs to change this in production.
  geminiBaseUrl: (env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com").replace(/\/$/, ""),
  // Диалоговая память: сколько последних пар «вопрос-ответ» подмешивать в
  // контекст запроса к провайдеру, и через сколько мс реплика считается
  // устаревшей и перестаёт учитываться.
  dialogTurns: Number(env.DIALOG_TURNS || 6),
  dialogTtlMs: Number(env.DIALOG_TTL_MS || 900000),
  // Озвучка ответа (TTS) через OpenAI-совместимый /audio/speech.
  // Gemini's AI_API_KEY is never used for this endpoint. For backwards
  // compatibility an OpenAI AI_API_KEY may be reused when TTS_* is omitted.
  // Если ответы берутся у Gemini, озвучка достаётся тем же ключом — Gemini
  // синтезирует речь сам. Отдельный сервис нужен только другим провайдерам.
  ttsProvider: env.TTS_PROVIDER || (env.AI_PROVIDER === "gemini" ? "gemini" : env.AI_PROVIDER === "openai" ? "openai-compatible" : "none"),
  // Модель и голос Gemini для синтеза. Голоса перечислены в документации
  // Gemini TTS; Kore — нейтральный женский, хорошо читает по-русски.
  geminiTtsModel: env.GEMINI_TTS_MODEL || "gemini-3.1-flash-tts-preview",
  geminiTtsVoice: env.GEMINI_TTS_VOICE || "Kore",
  ttsApiKey: env.TTS_API_KEY || (env.AI_PROVIDER === "openai" ? env.AI_API_KEY || "" : ""),
  ttsBaseUrl: (env.TTS_BASE_URL || (env.AI_PROVIDER === "openai" ? env.AI_BASE_URL || "https://api.openai.com/v1" : "https://api.openai.com/v1")).replace(/\/$/, ""),
  ttsModel: env.TTS_MODEL || "gpt-4o-mini-tts",
  ttsVoice: env.TTS_VOICE || "alloy",
  // Сколько мс живёт короткоживущий идентификатор озвучки (speechId),
  // выданный в ответах /api/v1/voice и /api/v1/query, пока часы не
  // скачали по нему аудио через GET /api/v1/speak/:id.
  speechTtlMs: Number(env.SPEECH_TTL_MS || 300000),
  // Tuya Cloud (OpenAPI) — прямое управление устройствами без Android-компаньона.
  // Интеграция считается включённой, если заданы оба ключа (accessId/accessSecret);
  // TUYA_UID нужен только для листинга устройств (GET /api/v1/home/devices).
  tuyaAccessId: env.TUYA_ACCESS_ID || "",
  tuyaAccessSecret: env.TUYA_ACCESS_SECRET || "",
  tuyaUid: env.TUYA_UID || "",
  tuyaBaseUrl: (env.TUYA_BASE_URL || "https://openapi.tuyaeu.com").replace(/\/$/, ""),
  tuyaTimeoutMs: Number(env.TUYA_TIMEOUT_MS || 10000)
};
const notesPath = join(config.dataDir, "notes.json");

// По умолчанию — прежнее поведение: заметки в файле, короткие ключи в памяти.
// setStore() подменяет хранилище при запуске на бесплатном хосте, где ни
// диска, ни памяти между запросами нет (см. store.mjs и deno-entry.mjs).
let store = createFileStore(config.dataDir);

function setStore(next) {
  store = next;
}

// Short-lived, bounded request-result cache. This protects the personal
// gateway from duplicate notes/actions when a watch loses the HTTP response.
const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;
const IDEMPOTENCY_MAX = 200;
const CONFIRMATION_TTL_MS = 2 * 60 * 1000;
const IDEMPOTENCY_PREFIX = "idem:";
const CONFIRMATION_PREFIX = "confirm:";

function requestId(req, body) {
  const value = req.headers["idempotency-key"] || req.headers["x-timew-request-id"] || body?.requestId;
  if (value === undefined) return null;
  const key = String(value).trim();
  if (!key || key.length > 128) {
    const err = new Error("requestId must be between 1 and 128 characters");
    err.statusCode = 400;
    throw err;
  }
  return key;
}

function idempotencyFingerprint(scope, body) {
  return createHash("sha256").update(`${scope}:${JSON.stringify(body)}`).digest("hex");
}

async function getIdempotent(key, fingerprint) {
  if (!key) return null;
  const hit = await store.kvGet(IDEMPOTENCY_PREFIX + key);
  if (!hit) return null;
  if (hit.fingerprint !== fingerprint) {
    const err = new Error("requestId was already used for a different request");
    err.statusCode = 409;
    err.code = "idempotency_conflict";
    throw err;
  }
  return hit.response;
}

async function putIdempotent(key, fingerprint, response) {
  if (!key) return;
  await store.kvSet(IDEMPOTENCY_PREFIX + key, { fingerprint, response }, IDEMPOTENCY_TTL_MS);
  // Верхняя граница на всякий случай: срок годности и так чистит записи, но
  // при шквале запросов за десять минут их может накопиться слишком много.
  while ((await store.kvCount(IDEMPOTENCY_PREFIX)) > IDEMPOTENCY_MAX) {
    const oldest = await store.kvOldest(IDEMPOTENCY_PREFIX);
    if (!oldest) break;
    await store.kvDelete(oldest);
  }
}

async function resetIdempotency() { await store.kvClear(IDEMPOTENCY_PREFIX); }

// Можно ли озвучивать ответы. Часы спрашивают это через /api/v1/status и
// пишут на экране, если озвучка недоступна: иначе включённая настройка
// просто молчала бы без объяснений.
function ttsAvailable() {
  if (config.ttsProvider === "gemini") return Boolean(config.apiKey);
  return Boolean(config.ttsApiKey && config.ttsProvider === "openai-compatible");
}

// Тип аудио определяется по самим байтам, а не по тому, что заявили часы.
//
// Причина из практики: рантайм Vela отдаёт путь к файлу, а расширение у него
// не всегда говорит правду. Когда часы не смогли распознать формат, они
// присылали application/octet-stream — такого типа в списке Gemini нет, и
// запрос отклонялся с «invalid argument», хотя запись была нормальной.
//
// Неизвестный формат не выдаём за поддерживаемый: пишем в лог первые байты,
// чтобы по следующему обращению стало понятно, что именно записывают часы.
const GEMINI_AUDIO_TYPES = new Set([
  "audio/wav", "audio/mp3", "audio/mpeg", "audio/aiff", "audio/aac", "audio/ogg",
  "audio/flac", "audio/m4a", "audio/l16", "audio/opus", "audio/alaw", "audio/mulaw", "audio/webm"
]);

function detectAudioMime(bytes, declared) {
  const head = bytes.subarray(0, 12);
  const ascii = head.toString("latin1");
  if (ascii.startsWith("OggS")) return "audio/ogg";
  if (ascii.startsWith("RIFF") && ascii.includes("WAVE")) return "audio/wav";
  if (ascii.startsWith("fLaC")) return "audio/flac";
  if (ascii.startsWith("#!AMR")) return "audio/amr";
  if (ascii.startsWith("ID3")) return "audio/mpeg";
  if (head[0] === 0xff && (head[1] & 0xe0) === 0xe0) return "audio/mpeg";
  if (ascii.slice(4, 8) === "ftyp") return "audio/m4a";
  if (ascii.startsWith("FORM") && ascii.includes("AIFF")) return "audio/aiff";
  if (declared && GEMINI_AUDIO_TYPES.has(declared)) return declared;
  return null;
}

// Возвращает тип, пригодный для Gemini, либо внятную ошибку. Отдельно
// оговорён AMR: часы некоторых прошивок пишут именно в нём, а Gemini его не
// принимает — молчаливый отказ тут хуже прямого объяснения.
function audioMimeForGemini(bytes, declared) {
  const detected = detectAudioMime(bytes, declared);
  if (detected === "audio/amr") {
    const err = new Error("Watch recorded AMR, which Gemini does not accept");
    err.statusCode = 415;
    err.publicMessage = "Часы записали в формате AMR, его распознавание не принимает";
    err.code = "unsupported_audio";
    throw err;
  }
  if (detected) return detected;
  console.error(`[${new Date().toISOString()}] неизвестный формат записи: заявлен ${declared || "ничего"}, первые байты ${bytes.subarray(0, 12).toString("hex")}`);
  const err = new Error(`Unrecognized audio format (declared ${declared || "none"})`);
  err.statusCode = 415;
  err.publicMessage = "Не удалось распознать формат записи";
  err.code = "unsupported_audio";
  throw err;
}

function publicMode() {
  return config.provider === "mock" || !config.apiKey ? "demo" : "live";
}

function isTuyaEnabled() {
  return Boolean(config.tuyaAccessId && config.tuyaAccessSecret);
}

function devicesConfigPath() {
  return join(config.dataDir, "devices.json");
}

function resolveDataDir(value) {
  return value.startsWith(".") ? join(ROOT, "..", value) : value;
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*"
  });
  res.end(payload);
}

function error(res, status, message, code = "bad_request") {
  json(res, status, { ok: false, error: { code, message } });
}

function authorized(req) {
  if (!config.token) return true;
  const provided = req.headers["x-timew-device-token"];
  if (typeof provided !== "string" || !provided) return false;
  const providedHash = createHash("sha256").update(provided).digest();
  const expectedHash = createHash("sha256").update(config.token).digest();
  return timingSafeEqual(providedHash, expectedHash);
}

async function bodyBuffer(req, limit) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > limit) throw Object.assign(new Error("Request is too large"), { statusCode: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function jsonBody(req) {
  const raw = await bodyBuffer(req, 64 * 1024);
  try {
    return JSON.parse(raw.toString("utf8") || "{}");
  } catch {
    throw Object.assign(new Error("Body must be valid JSON"), { statusCode: 400 });
  }
}

// Заметки и короткоживущие ключи живут в store — файл на диске при запуске
// на своей машине, Deno KV на бесплатном хосте. Подробности и причина
// разделения — в store.mjs.
async function loadNotes() {
  return store.loadNotes();
}

async function saveNotes(notes) {
  return store.saveNotes(notes);
}

let notesQueue = Promise.resolve();

// Serializes reads/modifications/writes of the notes file so concurrent
// requests can't clobber each other. `mutator` receives the current notes
// array and returns { notes, result } — `notes` (if present) is persisted,
// `result` is returned to the caller.
function withNotes(mutator) {
  const run = notesQueue.then(async () => {
    const notes = await loadNotes();
    const { notes: nextNotes, result } = await mutator(notes);
    if (nextNotes) await saveNotes(nextNotes);
    return result;
  });
  notesQueue = run.then(() => undefined, () => undefined);
  return run;
}

function parseNotesLimit(searchParams) {
  if (!searchParams.has("limit")) return { limit: 5 };
  const raw = searchParams.get("limit");
  if (!/^-?\d+$/.test(raw)) return { error: true };
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) return { error: true };
  return { limit: Math.min(50, value) };
}

// In-memory sliding-window rate limiter, keyed by client IP. No dependency
// on setInterval (which would keep the process/tests alive) — stale buckets
// are pruned lazily whenever a request touches them.
const rateLimitBuckets = new Map();

function clientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) return forwarded.split(",")[0].trim();
  return req.socket.remoteAddress || "unknown";
}

function checkRateLimit(ip) {
  const now = Date.now();
  const windowStart = now - config.rateLimitWindowMs;
  let bucket = rateLimitBuckets.get(ip);
  if (!bucket) {
    bucket = [];
    rateLimitBuckets.set(ip, bucket);
  }
  while (bucket.length && bucket[0] <= windowStart) bucket.shift();
  if (bucket.length >= config.rateLimitMax) return false;
  bucket.push(now);
  if (rateLimitBuckets.size > 1000) {
    for (const [key, timestamps] of rateLimitBuckets) {
      if (!timestamps.length || timestamps[timestamps.length - 1] <= windowStart) rateLimitBuckets.delete(key);
    }
  }
  return true;
}

// Test-only helper: clears rate-limit state so a test that lowers
// config.rateLimitMax doesn't leak counters into unrelated tests.
function resetRateLimit() {
  rateLimitBuckets.clear();
}

function normalizeText(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 500);
}

// Parses a `multipart/form-data` body into its parts. Operates entirely on
// Buffer slices (never converts the body to a string) so binary part
// contents — e.g. audio bytes that happen to be invalid UTF-8 — survive
// intact. Never throws: a malformed/truncated body just yields fewer (or
// zero) parts, which callers turn into a clear 400 instead of a crash.
function parseMultipart(buffer, boundary) {
  const parts = [];
  if (!boundary) return parts;
  const marker = Buffer.from(`--${boundary}`);
  const HEADER_SEP = Buffer.from("\r\n\r\n");
  let searchStart = 0;
  while (true) {
    const markerStart = buffer.indexOf(marker, searchStart);
    if (markerStart < 0) break;
    let pos = markerStart + marker.length;
    // Final boundary is `--boundary--` — stop, nothing more to parse.
    if (buffer[pos] === 0x2d && buffer[pos + 1] === 0x2d) break;
    // A part boundary is followed by CRLF before the part's headers.
    if (buffer[pos] === 0x0d && buffer[pos + 1] === 0x0a) pos += 2;
    const headerEnd = buffer.indexOf(HEADER_SEP, pos);
    if (headerEnd < 0) break;
    const nextMarkerStart = buffer.indexOf(marker, headerEnd + HEADER_SEP.length);
    if (nextMarkerStart < 0) break;
    let bodyEnd = nextMarkerStart;
    // Strip the trailing CRLF that precedes the next boundary.
    if (buffer[bodyEnd - 2] === 0x0d && buffer[bodyEnd - 1] === 0x0a) bodyEnd -= 2;
    const headerText = buffer.subarray(pos, headerEnd).toString("utf8");
    const bodyBytes = buffer.subarray(headerEnd + HEADER_SEP.length, bodyEnd);
    const headers = {};
    for (const line of headerText.split("\r\n")) {
      const idx = line.indexOf(":");
      if (idx < 0) continue;
      headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
    }
    const disposition = headers["content-disposition"] || "";
    const filenameMatch = /filename\s*=\s*"([^"]*)"/i.exec(disposition);
    const nameMatch = /(?:^|;)\s*name\s*=\s*"([^"]*)"/i.exec(disposition);
    parts.push({
      headers,
      name: nameMatch ? nameMatch[1] : undefined,
      filename: filenameMatch ? filenameMatch[1] : undefined,
      contentType: headers["content-type"],
      body: bodyBytes
    });
    searchStart = nextMarkerStart;
  }
  return parts;
}

// .opus / .wav / .pcm cover what @system.record on the watch produces;
// anything else falls back to a generic binary type.
function extensionMime(filename) {
  const ext = /\.([a-z0-9]+)$/i.exec(filename || "")?.[1]?.toLowerCase();
  if (ext === "opus") return "audio/opus";
  if (ext === "wav") return "audio/wav";
  if (ext === "pcm") return "application/octet-stream";
  return "application/octet-stream";
}

function parseBoundary(contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || "");
  return match ? (match[1] || match[2]).trim() : null;
}

// Xiaomi Watch S5's @system.record hands back a file URI, not raw bytes, so
// the watch uploads it via request.upload as multipart/form-data. This
// extracts the first file part (identified by `filename` in its
// Content-Disposition, regardless of field name) and resolves its audio
// Content-Type from the part's own header, falling back to the filename
// extension.
function extractMultipartAudio(body, contentType) {
  const boundary = parseBoundary(contentType);
  if (!boundary) throw Object.assign(new Error("Multipart boundary is missing in Content-Type"), { statusCode: 400 });
  const parts = parseMultipart(body, boundary);
  const filePart = parts.find((part) => part.filename);
  if (!filePart) throw Object.assign(new Error("Multipart request has no file part (missing filename in Content-Disposition)"), { statusCode: 400 });
  const resolvedContentType = filePart.contentType || extensionMime(filePart.filename);
  return { bytes: filePart.body, contentType: resolvedContentType };
}

// Reads a non-file text field (e.g. an optional `provider` override) out of
// a multipart body. Returns undefined if the boundary is missing or the
// field isn't present — never throws, since this is always an optional
// extra on top of the required audio part above.
function extractMultipartField(body, contentType, fieldName) {
  const boundary = parseBoundary(contentType);
  if (!boundary) return undefined;
  const parts = parseMultipart(body, boundary);
  const field = parts.find((part) => part.name === fieldName && !part.filename);
  return field ? field.body.toString("utf8").trim() : undefined;
}

// Shared by /api/v1/transcribe and /api/v1/voice: reads the raw request
// body, extracts audio bytes from either a raw body or multipart/form-data
// (reusing extractMultipartAudio — never duplicated), and enforces
// MAX_AUDIO_BYTES. Also hands back the raw buffer/content-type so callers
// that need multipart text fields (e.g. an optional `provider` override)
// can pull them out without re-reading the request.
// Запись приходит тремя способами, и все три нужны.
//
// JSON с полем audioBase64 — основной для часов. Рантайм Vela не умеет
// отправлять двоичное тело: проверено на устройстве, вместо записи в теле
// оказался обрывок текста HTTP-запроса («POST /api/v1…»), а заголовок типа
// он дополнил charset=utf-8, то есть счёл тело текстом. Текстовые запросы
// с часов работают надёжно, поэтому запись едет как base64.
//
// Сырые байты и multipart оставлены: ими пользуются дымовой прогон, другие
// клиенты и прошивки, где двоичное тело работает.
function decodeBase64Audio(raw) {
  let body;
  try {
    body = JSON.parse(raw.toString("utf8"));
  } catch {
    return null;
  }
  if (!body || typeof body.audioBase64 !== "string") return null;
  const bytes = Buffer.from(body.audioBase64, "base64");
  if (!bytes.length) throw Object.assign(new Error("audioBase64 is empty"), { statusCode: 400 });
  return { bytes, contentType: typeof body.contentType === "string" && body.contentType ? body.contentType : "application/octet-stream" };
}

async function readAudioBody(req) {
  const requestType = req.headers["content-type"] || "application/octet-stream";
  const raw = await bodyBuffer(req, Math.round(config.maxAudioBytes * 1.4) + 64 * 1024);
  if (!raw.length) throw Object.assign(new Error("audio body is required"), { statusCode: 400 });
  const isMultipart = requestType.toLowerCase().startsWith("multipart/form-data");
  const isJson = requestType.toLowerCase().startsWith("application/json");
  const fromJson = isJson ? decodeBase64Audio(raw) : null;
  const audio = fromJson || (isMultipart ? extractMultipartAudio(raw, requestType) : { bytes: raw, contentType: requestType });
  if (audio.bytes.length > config.maxAudioBytes) throw Object.assign(new Error("audio is too large"), { statusCode: 413 });
  return { ...audio, raw, requestType, isMultipart };
}

// Wraps fetch() with an AbortController-based timeout so a hung upstream
// service can never leave a request (and the watch's UI) waiting forever.
// Network failures (DNS, ECONNREFUSED, etc.) are also turned into a clear,
// public error instead of bubbling up as an opaque 500. Shared by the AI
// provider client and the Tuya client below — each passes its own timeout
// and Russian public-facing messages.
async function fetchWithTimeout(url, options, timeoutMs, messages) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (cause) {
    if (cause.name === "AbortError") {
      const timeoutError = new Error(`${messages.label} timed out after ${timeoutMs}ms`);
      timeoutError.statusCode = 504;
      timeoutError.publicMessage = messages.timeoutPublic;
      throw timeoutError;
    }
    const networkError = new Error(`${messages.label} request failed: ${cause.message}`);
    networkError.statusCode = 502;
    networkError.publicMessage = messages.networkPublic;
    throw networkError;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchProvider(url, options) {
  return fetchWithTimeout(url, options, config.providerTimeoutMs, {
    label: "AI provider",
    timeoutPublic: "AI не ответил вовремя. Попробуйте ещё раз.",
    networkPublic: "AI-сервис сейчас недоступен."
  });
}

async function fetchTuya(url, options) {
  return fetchWithTimeout(url, options, config.tuyaTimeoutMs, {
    label: "Tuya API",
    timeoutPublic: "Умный дом не ответил вовремя. Попробуйте ещё раз.",
    networkPublic: "Сервис умного дома сейчас недоступен."
  });
}

async function providerError(response, label) {
  var message = `${label} returned HTTP ${response.status}`;
  try {
    const payload = await response.json();
    const detail = payload?.error?.message || payload?.message;
    if (detail) message += `: ${normalizeText(detail)}`;
  } catch {}
  const cause = new Error(message);
  cause.statusCode = response.status === 429 ? 503 : 502;
  cause.publicMessage = response.status === 429
    ? "Лимит AI временно исчерпан. Попробуйте позже."
    : "AI-сервис сейчас недоступен.";
  throw cause;
}

// --- Tuya Cloud (OpenAPI) client ---------------------------------------------
//
// Signature scheme (confirmed against Tuya's official docs — see the report
// handed back with this change for sources/confidence levels per fact):
//   stringToSign = HTTPMethod + "\n" + SHA256(body).hex + "\n" + "" + "\n" + url
//   token request:    sign = HMAC-SHA256(client_id + t + nonce + stringToSign, secret) → hex, uppercase
//   business request:  sign = HMAC-SHA256(client_id + access_token + t + nonce + stringToSign, secret) → hex, uppercase
// We don't sign any custom headers, so the "Optional_Signature_key" segment
// of stringToSign is always empty; nonce is an optional UUID we generate per
// request (Tuya deduplicates on nonce+timestamp) but is not required — Tuya
// accepts an empty nonce as long as it's consistently absent from both the
// header and the signing string.

function sha256Hex(input) {
  return createHash("sha256").update(input || "", "utf8").digest("hex");
}

// Exported for a dedicated unit test — this is the piece that most commonly
// breaks integrations, so it's pinned against a known input/output pair.
function buildStringToSign({ method, body, url }) {
  return `${method}\n${sha256Hex(body)}\n\n${url}`;
}

function buildTuyaSign({ clientId, secret, t, nonce, accessToken, stringToSign }) {
  const raw = `${clientId}${accessToken || ""}${t}${nonce || ""}${stringToSign}`;
  return createHmac("sha256", secret).update(raw, "utf8").digest("hex").toUpperCase();
}

function tuyaApiError(data, label) {
  const detail = normalizeText(data?.msg || "неизвестная ошибка");
  const err = new Error(`${label}: Tuya API error ${data?.code}: ${data?.msg}`);
  err.statusCode = 502;
  err.publicMessage = `Умный дом вернул ошибку: ${detail}`;
  err.tuyaCode = data?.code;
  return err;
}

async function tuyaHttpError(response, label) {
  let detail = "";
  try {
    const payload = await response.json();
    detail = payload?.msg || payload?.message || "";
  } catch {}
  const err = new Error(`${label} returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
  err.statusCode = response.status === 429 ? 503 : 502;
  err.publicMessage = response.status === 429
    ? "Лимит запросов к умному дому временно исчерпан. Попробуйте позже."
    : "Сервис умного дома сейчас недоступен.";
  throw err;
}

// Codes Tuya returns for an invalid/expired access_token — worth one retry
// with a freshly-fetched token rather than surfacing the failure.
const TUYA_TOKEN_ERROR_CODES = new Set([1010, 1011]);

let tuyaTokenCache = null; // { accessToken, expireAt }

// Test-only helper, mirrors resetRateLimit(): lets a test that mutates Tuya
// config force a fresh token fetch instead of leaking a cached one.
function resetTuyaTokenCache() {
  tuyaTokenCache = null;
}

async function fetchTuyaToken() {
  const method = "GET";
  const url = "/v1.0/token?grant_type=1";
  const t = String(Date.now());
  const nonce = randomUUID();
  const stringToSign = buildStringToSign({ method, body: "", url });
  const sign = buildTuyaSign({ clientId: config.tuyaAccessId, secret: config.tuyaAccessSecret, t, nonce, stringToSign });
  const response = await fetchTuya(`${config.tuyaBaseUrl}${url}`, {
    method,
    headers: {
      client_id: config.tuyaAccessId,
      sign,
      t,
      nonce,
      sign_method: "HMAC-SHA256"
    }
  });
  if (!response.ok) await tuyaHttpError(response, "Tuya token endpoint");
  const data = await response.json();
  if (!data.success) throw tuyaApiError(data, "Не удалось получить токен Tuya");
  return {
    accessToken: data.result.access_token,
    expireAt: Date.now() + Number(data.result.expire_time || 7200) * 1000
  };
}

// Returns a cached access_token when it isn't close to expiring; otherwise
// fetches a new one. A 60s safety margin avoids racing the real expiry.
async function getTuyaAccessToken() {
  if (tuyaTokenCache && tuyaTokenCache.expireAt > Date.now() + 60000) {
    return tuyaTokenCache.accessToken;
  }
  tuyaTokenCache = await fetchTuyaToken();
  return tuyaTokenCache.accessToken;
}

// Signed business request against the Tuya Cloud API. Retries exactly once,
// with a forced token refresh, if Tuya reports the access_token as invalid
// or expired — any other API-level failure (device offline, bad device id,
// etc.) is surfaced immediately as a clear error instead of looping.
async function tuyaRequest(method, path, body, { allowRetry = true } = {}) {
  const accessToken = await getTuyaAccessToken();
  const bodyStr = body ? JSON.stringify(body) : "";
  const t = String(Date.now());
  const nonce = randomUUID();
  const stringToSign = buildStringToSign({ method, body: bodyStr, url: path });
  const sign = buildTuyaSign({ clientId: config.tuyaAccessId, secret: config.tuyaAccessSecret, t, nonce, accessToken, stringToSign });
  const response = await fetchTuya(`${config.tuyaBaseUrl}${path}`, {
    method,
    headers: {
      client_id: config.tuyaAccessId,
      access_token: accessToken,
      sign,
      t,
      nonce,
      sign_method: "HMAC-SHA256",
      "Content-Type": "application/json"
    },
    body: bodyStr || undefined
  });
  if (!response.ok) await tuyaHttpError(response, "Tuya API");
  const data = await response.json();
  if (data.success === false) {
    if (allowRetry && TUYA_TOKEN_ERROR_CODES.has(data.code)) {
      resetTuyaTokenCache();
      return tuyaRequest(method, path, body, { allowRetry: false });
    }
    throw tuyaApiError(data, "Tuya API");
  }
  return data.result;
}

// Reads the room→device-id mapping from data/devices.json, re-reading on
// every call. The file is tiny (a handful of room→id entries) and this
// endpoint/command path is only hit by occasional voice commands, so the
// cost of re-reading is negligible — simpler and always correct than an
// fs.watch-based cache that could go stale or miss an edit made while the
// gateway is running.
async function loadDeviceMap() {
  try {
    const raw = await readFile(devicesConfigPath(), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (cause) {
    if (cause.code === "ENOENT") return null;
    console.error(`[${new Date().toISOString()}] не удалось прочитать devices.json: ${cause.message}`);
    return null;
  }
}

// Devices safe enough to act on instantly, without a phone confirmation —
// flipping a light has no meaningful downside. Everything else (locks,
// gates, alarms, heated outlets, ...) always requires confirmation; this is
// a security boundary, not a default, so it stays a short explicit allowlist.
const SAFE_INSTANT_DEVICES = new Set(["light"]);

const ROOM_NAMES_RU = {
  bedroom: "спальне",
  living_room: "гостиной",
  kitchen: "кухне",
  bathroom: "ванной",
  office: "кабинете",
  kids_room: "детской"
};

function parseNote(text) {
  const match = text.match(/^(?:запиши|заметка|запомни|note)\s*[:：-]?\s*(.+)$/iu);
  return match ? normalizeText(match[1]) : null;
}

// Recognized device classes, in priority order. Only "light" is in
// SAFE_INSTANT_DEVICES above — the others (sockets, locks, gates, alarms)
// are matched so the parser can label the command clearly, but they always
// come back with requiresConfirmation:true and are never auto-executed.
const HOME_DEVICE_PATTERNS = [
  [/(свет|ламп|light)/u, "light"],
  [/(розетк|socket|outlet)/u, "socket"],
  [/(замо?к|дверь|lock)/u, "lock"],
  [/(ворота|гараж|gate)/u, "gate"],
  [/(сигнализац|охран|alarm)/u, "alarm"]
];

function parseHomeCommand(text) {
  const value = text.toLocaleLowerCase("ru-RU");
  const action = /(выключ|выкл|погаси|off)/u.test(value)
    ? "off"
    : /(включ|вкл|зажги|on)/u.test(value)
      ? "on"
      : null;
  if (!action) return null;
  const deviceEntry = HOME_DEVICE_PATTERNS.find(([pattern]) => pattern.test(value));
  if (!deviceEntry) return null;
  const rooms = [
    ["спальн", "bedroom"], ["гостин", "living_room"], ["кухн", "kitchen"],
    ["ванн", "bathroom"], ["кабинет", "office"], ["детск", "kids_room"]
  ];
  const room = rooms.find(([needle]) => value.includes(needle));
  return { action, device: deviceEntry[1], room: room ? room[1] : null };
}

function demoTranscript() {
  return "Тестовая запись с часов. Замените AI_PROVIDER на реальный режим для распознавания речи.";
}

// --- Dialog memory ------------------------------------------------------------
//
// A single in-process history of AI-kind exchanges only (notes and home
// commands never enter it — they aren't part of the conversation). Kept in
// memory only: this is a personal single-user gateway, so surviving a
// restart isn't required, but the history must persist across requests
// within the same process. Bounded to a generous hard cap so an idle
// process can't grow this unboundedly; the real trimming (by DIALOG_TURNS
// and DIALOG_TTL_MS) happens at read time so tests can mutate config on the
// fly, same pattern as rateLimitMax/rateLimitWindowMs above.
const DIALOG_HISTORY_HARD_CAP = 200;
const DIALOG_KEY = "dialog";

// История разговора тоже в store: без неё «Ещё вопрос» на часах каждый раз
// начинал бы с чистого листа, а на бесплатном хосте память между запросами
// не сохраняется.
async function recordDialogTurn(question, answer) {
  const history = (await store.kvGet(DIALOG_KEY)) || [];
  history.push({ question, answer, ts: Date.now() });
  const trimmed = history.length > DIALOG_HISTORY_HARD_CAP
    ? history.slice(history.length - DIALOG_HISTORY_HARD_CAP)
    : history;
  await store.kvSet(DIALOG_KEY, trimmed);
}

// Returns the most recent turns, oldest first, filtered by TTL and capped
// to config.dialogTurns — both read live so tests (and env changes) take
// effect without restarting the process.
async function getDialogHistory() {
  const history = (await store.kvGet(DIALOG_KEY)) || [];
  const cutoff = Date.now() - config.dialogTtlMs;
  const fresh = history.filter((turn) => turn.ts >= cutoff);
  return fresh.slice(-config.dialogTurns);
}

// Test-only export, mirrors resetRateLimit()/resetTuyaTokenCache(): lets a
// test start a conversation from a clean slate, and backs the
// POST /api/v1/dialog/reset endpoint.
async function resetDialogHistory() {
  const cleared = ((await store.kvGet(DIALOG_KEY)) || []).length;
  await store.kvDelete(DIALOG_KEY);
  return cleared;
}

// --- Speech registry (lazy TTS for the watch) --------------------------------
//
// @system.audio on the Xiaomi Watch S5 can only play a URL — it can't POST
// bytes or send headers, so it can't hit /api/v1/speak directly (that would
// also mean putting the device token in a URL, which leaks into proxy/tunnel
// logs). Instead, /api/v1/voice and /api/v1/query hand back a short-lived
// speechId; the watch downloads the audio separately via
// GET /api/v1/speak/:id using request.download, which DOES support a
// header, so the token travels there instead of in the URL. Synthesis is
// deliberately deferred to that GET — registering here just remembers the
// text, so we never pay for TTS on every AI answer, only for the ones the
// user actually plays (voice output is off by default on the watch).
//
// In-memory only, keyed by randomUUID(). No setInterval — like the rate
// limiter above, expired entries are pruned lazily on access so the process
// (and tests) don't get an extra timer keeping them alive. Bounded to a
// small cap so a chatty session can't grow this unboundedly.
const SPEECH_REGISTRY_MAX = 50;
const SPEECH_PREFIX = "speech:";

// Идентификатор выдаётся сразу, а запись в хранилище идёт следом, не
// задерживая ответ. Хранилище живёт в другом регионе, и каждое обращение
// стоит около 150 мс — на часах это заметно, а ответу эта запись не нужна:
// озвучку человек запрашивает отдельным запросом секундой позже.
function registerSpeech(text) {
  const id = randomUUID();
  const write = (async () => {
    await store.kvSet(SPEECH_PREFIX + id, { text }, config.speechTtlMs);
    if ((await store.kvCount(SPEECH_PREFIX)) > SPEECH_REGISTRY_MAX) {
      const oldest = await store.kvOldest(SPEECH_PREFIX);
      if (oldest) await store.kvDelete(oldest);
    }
  })();
  trackBackgroundWrite(write, "registerSpeech");
  return id;
}

// Фоновые записи нельзя просто бросить: необработанный отказ промиса роняет
// процесс в Deno, а на часах это выглядело бы как внезапно умерший шлюз.
// Ошибку пишем в лог и живём дальше — потеря истории диалога не стоит отказа
// в обслуживании.
const backgroundWrites = new Set();
function trackBackgroundWrite(promise, label) {
  backgroundWrites.add(promise);
  promise
    .catch((cause) => console.error(`[${new Date().toISOString()}] фоновая запись ${label} не удалась: ${cause.message}`))
    .finally(() => backgroundWrites.delete(promise));
}

// Тесты ждут, пока фоновые записи улягутся: иначе проверка истории диалога
// гоняется с ещё не завершённой записью и падает через раз.
async function settleBackgroundWrites() {
  while (backgroundWrites.size) await Promise.allSettled(Array.from(backgroundWrites));
}

// Returns the registered text for a still-fresh id, or null if the id is
// unknown or has expired. Expired entries are deleted on the way out —
// lazy cleanup, same pattern as checkRateLimit() above.
async function takeSpeechText(id) {
  const entry = await store.kvGet(SPEECH_PREFIX + id);
  return entry ? entry.text : null;
}

// Test-only helper, mirrors resetRateLimit()/resetDialogHistory(): lets a
// test start with an empty registry instead of leaking entries between
// tests.
async function resetSpeechRegistry() {
  await store.kvClear(SPEECH_PREFIX);
}

function historyToOpenAIMessages(history) {
  const messages = [];
  for (const turn of history) {
    messages.push({ role: "user", content: turn.question });
    messages.push({ role: "assistant", content: turn.answer });
  }
  return messages;
}

function historyToGeminiContents(history) {
  const contents = [];
  for (const turn of history) {
    contents.push({ role: "user", parts: [{ text: turn.question }] });
    contents.push({ role: "model", parts: [{ text: turn.answer }] });
  }
  return contents;
}

// --- Per-request provider selection ------------------------------------------
//
// Resolves the optional `provider` override (from the request body or a
// ?provider= query param) into an effective provider string, WITHOUT ever
// mutating config — config.provider stays the gateway-wide default so
// concurrent requests with different overrides can't clobber each other.
// Throws a public, typed error (never a silent demo fallback) for an
// unknown value or a provider the gateway has no key for.
function resolveRequestedProvider(raw) {
  const value = raw === undefined || raw === null ? "" : String(raw).trim().toLowerCase();
  if (!value || value === "auto") return config.provider;
  if (value === "gemini" || value === "openai") {
    if (!config.apiKey) {
      const err = new Error(`Provider "${value}" was requested but the gateway has no AI_API_KEY configured`);
      err.statusCode = 503;
      err.publicMessage = "Провайдер не настроен на шлюзе";
      throw err;
    }
    return value;
  }
  const err = new Error(`Unknown provider "${raw}". Allowed values: auto, gemini, openai.`);
  err.statusCode = 400;
  err.publicMessage = `Неизвестный provider: "${raw}". Допустимо: auto, gemini, openai.`;
  throw err;
}

async function providerChat(text, { provider = config.provider, history = [] } = {}) {
  if (provider === "mock" || !config.apiKey) {
    return { text: `Демо-ответ TimeW: ${text.slice(0, 180)}`, source: "demo" };
  }
  if (provider === "gemini") {
    const contents = [...historyToGeminiContents(history), { role: "user", parts: [{ text }] }];
    const response = await fetchProvider(`${config.geminiBaseUrl}/v1beta/models/${config.geminiModel}:generateContent?key=${encodeURIComponent(config.apiKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: "Отвечай по-русски, коротко и понятно для экрана часов. Не используй markdown." }] },
        contents,
        generationConfig: {
          maxOutputTokens: 256,
          temperature: 0.2,
          thinkingConfig: { thinkingBudget: 0 }
        }
      })
    });
    if (!response.ok) await providerError(response, "Gemini");
    const data = await response.json();
    return { text: normalizeText(data.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("")), source: "gemini" };
  }
  const messages = [
    { role: "system", content: "Отвечай по-русски, коротко и понятно для экрана часов. Не используй markdown." },
    ...historyToOpenAIMessages(history),
    { role: "user", content: text }
  ];
  const response = await fetchProvider(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.model,
      messages,
      max_tokens: 180,
      temperature: 0.2
    })
  });
  if (!response.ok) await providerError(response, "AI provider");
  const data = await response.json();
  return { text: normalizeText(data.choices?.[0]?.message?.content), source: provider };
}

async function providerTranscribe(audio, contentType, { provider = config.provider } = {}) {
  if (provider === "mock" || !config.apiKey) {
    return { text: demoTranscript(), source: "demo" };
  }
  if (provider === "gemini") {
    const response = await fetchProvider(`${config.geminiBaseUrl}/v1beta/models/${config.geminiModel}:generateContent?key=${encodeURIComponent(config.apiKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [
          { text: "Точно расшифруй русскую речь из аудио. Верни только распознанный текст без пояснений." },
          { inlineData: { mimeType: audioMimeForGemini(audio, contentType), data: audio.toString("base64") } }
        ] }],
        generationConfig: {
          maxOutputTokens: 256,
          temperature: 0,
          thinkingConfig: { thinkingBudget: 0 }
        }
      })
    });
    if (!response.ok) await providerError(response, "Gemini transcription");
    const data = await response.json();
    return { text: normalizeText(data.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("")), source: "gemini" };
  }
  const form = new FormData();
  form.append("file", new Blob([audio], { type: contentType || "application/octet-stream" }), "timew-audio");
  form.append("model", config.transcribeModel);
  form.append("language", "ru");
  const response = await fetchProvider(`${config.baseUrl}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.apiKey}` },
    body: form
  });
  if (!response.ok) await providerError(response, "Transcription provider");
  const data = await response.json();
  return { text: normalizeText(data.text), source: provider };
}

// Gemini-only optimization for /api/v1/voice: a single generateContent call
// that both transcribes the audio AND answers the recognized question, via
// a JSON-schema response ({transcript, answer}). Saves the second Wi-Fi
// round trip the watch would otherwise pay for a plain question. The caller
// is responsible for discarding `answer` when the transcript turns out to
// be a note or a home command — this function only ever transcribes+answers,
// it never classifies or executes anything itself.
async function providerVoiceGemini(audioBytes, contentType, history) {
  const contents = [
    ...historyToGeminiContents(history),
    {
      role: "user",
      parts: [
        {
          text: "Сначала точно расшифруй русскую речь из аудио в поле transcript, без пояснений. " +
            "Затем ответь на распознанный вопрос по-русски, коротко и понятно для экрана часов, без markdown, в поле answer. " +
            "Верни строго JSON по заданной схеме."
        },
        { inlineData: { mimeType: audioMimeForGemini(audioBytes, contentType), data: audioBytes.toString("base64") } }
      ]
    }
  ];
  const response = await fetchProvider(`${config.geminiBaseUrl}/v1beta/models/${config.geminiModel}:generateContent?key=${encodeURIComponent(config.apiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: "Отвечай по-русски, коротко и понятно для экрана часов. Не используй markdown." }] },
      contents,
      generationConfig: {
        maxOutputTokens: 512,
        temperature: 0.2,
        thinkingConfig: { thinkingBudget: 0 },
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            transcript: { type: "STRING" },
            answer: { type: "STRING" }
          },
          required: ["transcript", "answer"]
        }
      }
    })
  });
  if (!response.ok) await providerError(response, "Gemini");
  const data = await response.json();
  const raw = data.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("") || "{}";
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = {};
  }
  return {
    transcript: normalizeText(parsed.transcript),
    answer: normalizeText(parsed.answer)
  };
}

// Executes (or declines to execute) a home-automation command. This is the
// ONLY path that ever calls into Tuya, and it only ever receives commands
// produced by parseHomeCommand()'s regex parser above — free-form AI/model
// output is never passed here. That's a deliberate security boundary: the
// model can describe intent in its reply text, but it can never itself
// cause a Tuya command to be sent.
// Executes (or declines to execute) a home-automation command and returns
// the response body — never writes to `res` itself, so both
// /api/v1/query and /api/v1/voice can add their own extra fields (e.g. a
// transcript) before sending it.
async function executeHomeCommand(command, deviceIds) {
  const value = command.action === "on";
  await Promise.all(deviceIds.map((id) => tuyaRequest("POST", `/v1.0/iot-03/devices/${id}/commands`, {
    commands: [{ code: "switch_led", value }]
  })));
  const roomText = ROOM_NAMES_RU[command.room] || command.room;
  return {
    ok: true, kind: "home", command, executed: true,
    requiresConfirmation: false,
    text: `${command.action === "off" ? "Выключил" : "Включил"} свет в ${roomText}`,
    devices: deviceIds, source: "tuya"
  };
}

async function buildHomeCommandResult(command) {
  const base = { ok: true, kind: "home", command, executed: false };
  // Every home command is prepared first. Even harmless lights require an
  // explicit, separate confirmation so a misheard watch command has no side
  // effect. The token is single-use and expires quickly.
  if (!SAFE_INSTANT_DEVICES.has(command.device)) {
    return { ...base, text: "Команда распознана. Нужна проверка на телефоне.", requiresConfirmation: true, source: "parser" };
  }
  if (!command.room) {
    return { ...base, text: "Уточните комнату.", requiresConfirmation: true, source: "parser" };
  }
  if (!isTuyaEnabled()) {
    return { ...base, text: "Команда распознана, но управление умным домом не настроено.", requiresConfirmation: true, source: "parser" };
  }

  const deviceMap = await loadDeviceMap();
  const deviceIds = deviceMap ? deviceMap[command.room] : null;
  if (!deviceIds || !deviceIds.length) {
    return {
      ...base,
      text: deviceMap
        ? `Для комнаты «${command.room}» не настроены устройства.`
        : "Устройства не настроены (создайте server/data/devices.json).",
      requiresConfirmation: true,
      source: "parser"
    };
  }

  const token = randomUUID();
  const expiresAt = Date.now() + CONFIRMATION_TTL_MS;
  await store.kvSet(CONFIRMATION_PREFIX + token, { command, deviceIds }, CONFIRMATION_TTL_MS);
  return {
    ...base,
    text: "Команда подготовлена. Подтвердите выполнение.",
    requiresConfirmation: true,
    confirmationToken: token,
    confirmationExpiresAt: new Date(expiresAt).toISOString(),
    source: "parser"
  };
}

async function confirmHomeCommand(token) {
  const entry = await store.kvGet(CONFIRMATION_PREFIX + token);
  if (!entry) return null;
  // Удаляем до исполнения: токен одноразовый, и повтор не должен зажечь свет
  // второй раз, даже если первое исполнение упало.
  await store.kvDelete(CONFIRMATION_PREFIX + token);
  return executeHomeCommand(entry.command, entry.deviceIds);
}

// Saves a note and returns the response body — same non-writing contract as
// buildHomeCommandResult, for the same reason (shared by /query and /voice).
async function buildNoteResult(note) {
  const item = await withNotes((notes) => {
    const record = { id: crypto.randomUUID(), text: note, createdAt: new Date().toISOString() };
    notes.unshift(record);
    return { notes, result: record };
  });
  return { ok: true, kind: "note", text: `Записал: ${note}`, note: item, source: "local" };
}

async function handleQuery(req, res, reqUrl) {
  const body = await jsonBody(req);
  const requestKey = requestId(req, body);
  const fingerprint = idempotencyFingerprint("query", body);
  const cached = await getIdempotent(requestKey, fingerprint);
  if (cached) return json(res, cached.status, cached.body);
  const text = normalizeText(body.text);
  if (!text) return error(res, 400, "text is required");
  const providerParam = body.provider !== undefined ? body.provider : reqUrl.searchParams.get("provider");
  const provider = resolveRequestedProvider(providerParam);

  const note = parseNote(text);
  if (note) {
    const result = await buildNoteResult(note);
    await putIdempotent(requestKey, fingerprint, { status: 200, body: result });
    return json(res, 200, result);
  }
  const command = parseHomeCommand(text);
  if (command) {
    const result = await buildHomeCommandResult(command);
    await putIdempotent(requestKey, fingerprint, { status: 200, body: result });
    return json(res, 200, result);
  }
  const history = await getDialogHistory();
  const result = await providerChat(text, { provider, history });
  trackBackgroundWrite(recordDialogTurn(text, result.text), "recordDialogTurn");
  const speechId = result.text ? registerSpeech(result.text) : undefined;
  const response = { ok: true, kind: "ai", ...result, ...(speechId ? { speechId } : {}) };
  await putIdempotent(requestKey, fingerprint, { status: 200, body: response });
  return json(res, 200, response);
}

// POST /api/v1/voice: audio in, a ready-to-speak answer out — replaces the
// watch's transcribe-then-query round trip with a single HTTP call (still
// one network call to the AI provider in the common case, via the Gemini
// single-call optimization below).
async function handleVoice(req, res, reqUrl) {
  const audio = await readAudioBody(req);
  const providerField = audio.isMultipart ? extractMultipartField(audio.raw, audio.requestType, "provider") : undefined;
  const providerParam = providerField !== undefined ? providerField : reqUrl.searchParams.get("provider");
  const provider = resolveRequestedProvider(providerParam);

  // На часах нет ввода текста (в рантайме Vela нет prompt.show и элемента
  // input), поэтому заметка тоже надиктовывается. Кнопка «Заметка» передаёт
  // intent=note, и распознанное сохраняется как заметка независимо от
  // формулировки — без этого пришлось бы каждый раз говорить «запиши».
  // Это единственное, на что intent влияет: исполнять что-либо по нему
  // нельзя, домашние команды по-прежнему распознаёт только parseHomeCommand.
  const intentField = audio.isMultipart ? extractMultipartField(audio.raw, audio.requestType, "intent") : undefined;
  const intentParam = intentField !== undefined ? intentField : reqUrl.searchParams.get("intent");
  const forceNote = intentParam === "note";
  const previewNote = forceNote && reqUrl.searchParams.get("preview") === "1";
  const requestField = audio.isMultipart ? extractMultipartField(audio.raw, audio.requestType, "requestId") : undefined;
  const requestKey = requestId(req, { requestId: requestField, provider: providerParam || "auto", intent: intentParam || "", audio: audio.bytes.toString("base64") });
  const fingerprint = idempotencyFingerprint("voice", { provider: providerParam || "auto", intent: intentParam || "", audio: audio.bytes.toString("base64") });
  const cached = await getIdempotent(requestKey, fingerprint);
  if (cached) return json(res, cached.status, cached.body);

  // Gemini optimization: one call transcribes AND answers. Only safe to use
  // the model's `answer` when the transcript turns out to be a plain
  // question — a note or home command always uses OUR classification and
  // OUR result, and the model's answer is discarded, never surfaced or
  // acted on.
  if (provider === "gemini" && config.apiKey) {
    const history = await getDialogHistory();
    const { transcript, answer } = await providerVoiceGemini(audio.bytes, audio.contentType, history);

    if (previewNote) {
      const response = { ok: true, kind: "draft", transcript, text: "Проверьте распознанную заметку", source: "gemini" };
      await putIdempotent(requestKey, fingerprint, { status: 200, body: response });
      return json(res, 200, response);
    }
    const note = forceNote ? normalizeText(transcript) : parseNote(transcript);
    if (note) {
      const result = await buildNoteResult(note);
      const response = { ...result, transcript };
      await putIdempotent(requestKey, fingerprint, { status: 200, body: response });
      return json(res, 200, response);
    }
    const command = parseHomeCommand(transcript);
    if (command) {
      const result = await buildHomeCommandResult(command);
      const response = { ...result, transcript };
      await putIdempotent(requestKey, fingerprint, { status: 200, body: response });
      return json(res, 200, response);
    }
    trackBackgroundWrite(recordDialogTurn(transcript, answer), "recordDialogTurn");
    const speechId = answer ? registerSpeech(answer) : undefined;
    const response = { ok: true, transcript, kind: "ai", text: answer, source: "gemini", ...(speechId ? { speechId } : {}) };
    await putIdempotent(requestKey, fingerprint, { status: 200, body: response });
    return json(res, 200, response);
  }

  // Every other provider (mock/demo, openai-compatible): sequential
  // transcribe-then-answer, same classification path as /api/v1/query.
  const transcribed = await providerTranscribe(audio.bytes, audio.contentType, { provider });
  const transcript = transcribed.text;

  if (previewNote) {
    const response = { ok: true, kind: "draft", transcript, text: "Проверьте распознанную заметку", source: transcribed.source };
    await putIdempotent(requestKey, fingerprint, { status: 200, body: response });
    return json(res, 200, response);
  }
  const note = forceNote ? normalizeText(transcript) : parseNote(transcript);
  if (note) {
    const result = await buildNoteResult(note);
    const response = { ...result, transcript };
    await putIdempotent(requestKey, fingerprint, { status: 200, body: response });
    return json(res, 200, response);
  }
  const command = parseHomeCommand(transcript);
  if (command) {
    const result = await buildHomeCommandResult(command);
    const response = { ...result, transcript };
    await putIdempotent(requestKey, fingerprint, { status: 200, body: response });
    return json(res, 200, response);
  }
  const history = await getDialogHistory();
  const result = await providerChat(transcript, { provider, history });
  trackBackgroundWrite(recordDialogTurn(transcript, result.text), "recordDialogTurn");
  const speechId = result.text ? registerSpeech(result.text) : undefined;
  const response = { ok: true, transcript, kind: "ai", ...result, ...(speechId ? { speechId } : {}) };
  await putIdempotent(requestKey, fingerprint, { status: 200, body: response });
  return json(res, 200, response);
}

// Shared by POST /api/v1/speak and GET /api/v1/speak/:id: turns text into an
// mp3 Buffer via an OpenAI-compatible /audio/speech call. Never fakes
// success: no key (or provider=mock) is a clear, typed 503, not silent
// audio; upstream HTTP failures become the usual 502/503/504 via
// providerError()/fetchProvider(), never a bare 500.
// Gemini отдаёт озвучку сырыми сэмплами (audio/L16, 16 бит, моно), без
// контейнера — проиграть такое нельзя ни в браузере, ни на часах. Дописываем
// 44-байтовый заголовок WAV, и получается обычный файл.
//
// Частоту берём из mimeType ответа, а не зашиваем: она указана там явно
// (`rate=24000`), и если Google её поменяет, зашитое число дало бы звук,
// воспроизводимый на неверной скорости — ошибка, которую слышно, но по коду
// не видно.
function pcmToWav(pcm, sampleRate) {
  const header = Buffer.alloc(44);
  const channels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM без сжатия
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(channels * (bitsPerSample / 8), 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

// Озвучка через Gemini — тем же ключом, что и ответы. Отдельный ключ нужен
// только если AI берётся у другого провайдера.
async function synthesizeSpeechGemini(text) {
  const url = `${config.geminiBaseUrl}/v1beta/models/${config.geminiTtsModel}:generateContent`;
  const response = await fetchProvider(url, {
    method: "POST",
    headers: { "x-goog-api-key": config.apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: config.geminiTtsVoice } } }
      }
    })
  });
  if (!response.ok) await providerError(response, "Gemini TTS");
  const body = await response.json();
  const part = body?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData || p.inline_data);
  const inline = part && (part.inlineData || part.inline_data);
  if (!inline?.data) {
    const err = new Error("Gemini TTS вернул ответ без аудио");
    err.statusCode = 502;
    err.publicMessage = "Озвучка не пришла от провайдера";
    err.code = "provider_error";
    throw err;
  }
  const rate = Number((String(inline.mimeType || inline.mime_type || "").match(/rate=(\d+)/) || [])[1]) || 24000;
  return { audio: pcmToWav(Buffer.from(inline.data, "base64"), rate), contentType: "audio/wav" };
}

async function synthesizeSpeech(text) {
  // Runtime compatibility for tests/older local setups that switch the AI
  // provider object directly. Never inherit credentials from Gemini.
  const ttsProvider = config.ttsProvider === "none" && config.provider === "openai-compatible"
    ? "openai-compatible" : config.ttsProvider;
  const ttsApiKey = ttsProvider === "openai-compatible" && config.ttsApiKey
    ? config.ttsApiKey
    : (ttsProvider === "openai-compatible" && config.provider === "openai-compatible" ? config.apiKey : "");
  const ttsBaseUrl = ttsProvider === "openai-compatible" && config.ttsApiKey
    ? config.ttsBaseUrl : config.baseUrl;
  // Gemini умеет синтез сам, тем же ключом: отдельный сервис нужен только
  // если ответы берутся у другого провайдера.
  if (ttsProvider === "gemini") {
    if (!config.apiKey) {
      const err = new Error("Gemini TTS requires AI_API_KEY");
      err.statusCode = 503;
      err.publicMessage = "Озвучка недоступна: не задан AI_API_KEY";
      err.code = "tts_unavailable";
      throw err;
    }
    return synthesizeSpeechGemini(text);
  }
  if (ttsProvider === "mock") {
    const err = new Error("TTS mock provider is not available");
    err.statusCode = 503;
    err.publicMessage = "Озвучка недоступна: TTS mock не реализован";
    err.code = "tts_unavailable";
    throw err;
  }
  if (!ttsApiKey || ttsProvider !== "openai-compatible") {
    const err = new Error("TTS is not configured on the gateway");
    err.statusCode = 503;
    err.publicMessage = "Озвучка недоступна: задайте TTS_PROVIDER=gemini (тем же ключом) или TTS_API_KEY для отдельного сервиса";
    err.code = "tts_unavailable";
    throw err;
  }
  const response = await fetchProvider(`${ttsBaseUrl}/audio/speech`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ttsApiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.ttsModel,
      voice: config.ttsVoice,
      input: text,
      response_format: "mp3"
    })
  });
  if (!response.ok) await providerError(response, "TTS provider");
  return { audio: Buffer.from(await response.arrayBuffer()), contentType: "audio/mpeg" };
}

// Тип содержимого зависит от провайдера: OpenAI-совместимый отдаёт mp3,
// Gemini — WAV, собранный нами из сырых сэмплов. Часы скачивают файл и
// проигрывают его, поэтому заголовок должен быть честным.
function sendAudio(res, audioBuffer, contentType) {
  res.writeHead(200, {
    "Content-Type": contentType || "audio/mpeg",
    "Content-Length": audioBuffer.length,
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*"
  });
  res.end(audioBuffer);
}

// POST /api/v1/speak: text in, audio/mpeg out (streamed as the response
// body, not JSON). Handy for testing synthesis straight from a computer;
// the watch itself uses GET /api/v1/speak/:id instead (see below), since
// @system.audio can only play a URL, not POST bytes.
async function handleSpeak(req, res) {
  const body = await jsonBody(req);
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) return error(res, 400, "text is required");
  if (text.length > 1000) return error(res, 400, "text must be at most 1000 characters long");
  const speech = await synthesizeSpeech(text);
  sendAudio(res, speech.audio, speech.contentType);
}

// GET /api/v1/speak/:id: synthesizes the text registered earlier under this
// speechId (by /api/v1/voice or /api/v1/query) and streams it back as
// audio/mpeg. This is what the watch's request.download hits — a plain URL,
// with the device token in a header rather than the query string.
async function handleSpeakById(req, res, id) {
  const text = await takeSpeechText(id);
  if (text === null) {
    return error(res, 404, "Озвучка не найдена или устарела, запросите ответ заново", "not_found");
  }
  const speech = await synthesizeSpeech(text);
  sendAudio(res, speech.audio, speech.contentType);
}

async function route(req, res) {
  const url = new URL(req.url, "http://localhost");
  const pathname = url.pathname;

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-TimeW-Device-Token, Idempotency-Key, X-TimeW-Request-Id",
      "Access-Control-Max-Age": "86400"
    });
    return res.end();
  }

  if (!checkRateLimit(clientIp(req))) {
    return error(res, 429, "Слишком много запросов. Попробуйте немного позже.", "rate_limited");
  }

  if (req.method === "GET" && pathname === "/health") {
    return json(res, 200, { ok: true, service: "timew-gateway", mode: publicMode(), version: "0.2.0", buildId: config.buildId });
  }

  if (!authorized(req)) return error(res, 401, "Invalid device token", "unauthorized");

  if (req.method === "GET" && pathname === "/api/v1/status") {
    return json(res, 200, {
      ok: true,
      service: "timew-gateway",
      mode: publicMode(),
      provider: config.provider,
      buildId: config.buildId,
      capabilities: {
        ai: publicMode() === "live",
        notes: true,
        speech: ttsAvailable(),
        home: isTuyaEnabled(),
        homeConfirmation: true
      }
    });
  }

  if (req.method === "POST" && pathname === "/api/v1/home/confirm") {
    const body = await jsonBody(req);
    const token = typeof body.confirmationToken === "string" ? body.confirmationToken.trim() : "";
    if (!token) return error(res, 400, "confirmationToken is required");
    const result = await confirmHomeCommand(token);
    if (!result) return error(res, 410, "Подтверждение отсутствует или устарело", "confirmation_expired");
    return json(res, 200, result);
  }

  if (req.method === "GET" && pathname === "/api/v1/notes") {
    const parsed = parseNotesLimit(url.searchParams);
    if (parsed.error) return error(res, 400, "limit must be an integer between 1 and 50");
    const notes = await withNotes((notes) => ({ result: notes }));
    return json(res, 200, { ok: true, notes: notes.slice(0, parsed.limit) });
  }

  const noteIdMatch = pathname.match(/^\/api\/v1\/notes\/([^/]+)$/);
  if (req.method === "DELETE" && noteIdMatch) {
    const id = decodeURIComponent(noteIdMatch[1]);
    const outcome = await withNotes((notes) => {
      const index = notes.findIndex((item) => item.id === id);
      if (index === -1) return { result: { deleted: false } };
      notes.splice(index, 1);
      return { notes, result: { deleted: true } };
    });
    if (!outcome.deleted) return error(res, 404, "Note not found", "not_found");
    return json(res, 200, { ok: true, deleted: true, id });
  }

  if (req.method === "GET" && pathname === "/api/v1/home/devices") {
    if (!isTuyaEnabled()) {
      return error(res, 503, "Интеграция с умным домом не настроена (задайте TUYA_ACCESS_ID и TUYA_ACCESS_SECRET)", "tuya_disabled");
    }
    if (!config.tuyaUid) {
      return error(res, 503, "Не задан TUYA_UID — не могу получить список устройств", "tuya_disabled");
    }
    const deviceMap = (await loadDeviceMap()) || {};
    const result = await tuyaRequest("GET", `/v1.0/users/${encodeURIComponent(config.tuyaUid)}/devices`);
    const devices = (Array.isArray(result) ? result : []).map((item) => ({
      id: item.id,
      name: item.name,
      category: item.category,
      online: item.online
    }));
    return json(res, 200, { ok: true, devices, rooms: deviceMap });
  }

  if (req.method === "POST" && pathname === "/api/v1/query") return handleQuery(req, res, url);
  if (req.method === "POST" && pathname === "/api/v1/voice") return handleVoice(req, res, url);
  if (req.method === "POST" && pathname === "/api/v1/speak") return handleSpeak(req, res);
  const speechIdMatch = pathname.match(/^\/api\/v1\/speak\/([^/]+)$/);
  if (req.method === "GET" && speechIdMatch) return handleSpeakById(req, res, decodeURIComponent(speechIdMatch[1]));
  // Отчёт диагностики с часов. Единственный способ увидеть, что происходит
  // на устройстве: экрана оттуда не видно, а логи рантайма Vela достаются
  // только через телефон. Часы присылают результаты своих проверок, шлюз
  // пишет их одной строкой в лог — и её можно прочитать удалённо.
  if (req.method === "POST" && pathname === "/api/v1/diag") {
    const body = await jsonBody(req);
    const report = JSON.stringify(body).slice(0, 4000);
    console.log(`${new Date().toISOString()} DIAG ${report}`);
    return json(res, 200, { ok: true, received: report.length, buildId: config.buildId });
  }

  if (req.method === "POST" && pathname === "/api/v1/dialog/reset") {
    const cleared = await resetDialogHistory();
    return json(res, 200, { ok: true, cleared });
  }
  if (req.method === "POST" && pathname === "/api/v1/transcribe") {
    const audio = await readAudioBody(req);
    const result = await providerTranscribe(audio.bytes, audio.contentType);
    return json(res, 200, { ok: true, ...result });
  }
  return error(res, 404, "Not found", "not_found");
}

const server = http.createServer((req, res) => {
  const startedAt = Date.now();
  const method = req.method || "GET";
  let loggedPath = req.url || "";
  try {
    loggedPath = new URL(req.url, "http://localhost").pathname;
  } catch {}
  if (config.logRequests) {
    res.on("finish", () => {
      console.log(`${new Date().toISOString()} ${method} ${loggedPath} ${res.statusCode} ${Date.now() - startedAt}ms`);
    });
  }
  route(req, res).catch((cause) => {
    const status = cause.statusCode || 500;
    console.error(`[${new Date().toISOString()}] ${method} ${loggedPath}: ${cause.message}`);
    if (!res.headersSent) error(
      res,
      status,
      cause.publicMessage || (status === 500 ? "Internal server error" : cause.message),
      cause.code || (status === 500 ? "internal_error" : status === 502 || status === 503 || status === 504 ? "provider_error" : "request_error")
    );
    else res.destroy();
  });
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (config.provider !== "mock" && !config.apiKey) {
    console.warn(`Внимание: AI_PROVIDER=${config.provider}, но AI_API_KEY пуст — шлюз фактически работает в demo-режиме.`);
  }
  if (!["mock", "gemini", "openai"].includes(config.provider)) {
    console.warn(`Внимание: неизвестный AI_PROVIDER="${config.provider}" — используется OpenAI-совместимый путь.`);
  }
  if (!config.token) {
    console.warn("Внимание: DEVICE_TOKEN не задан — шлюз работает без токена, его нельзя выставлять в интернет в таком виде.");
  }

  server.listen(config.port, config.host, () => {
    console.log(`TimeW gateway listening on http://${config.host}:${config.port} (${config.provider === "mock" ? "demo" : "live"})`);
  });

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`Получен ${signal}, завершаю работу...`);
    const forceExit = setTimeout(() => {
      console.error("Не удалось завершиться штатно за 5с, выхожу принудительно.");
      process.exit(1);
    }, 5000);
    if (forceExit.unref) forceExit.unref();
    server.close(() => {
      notesQueue.then(
        () => {
          clearTimeout(forceExit);
          process.exit(0);
        },
        () => {
          clearTimeout(forceExit);
          process.exit(0);
        }
      );
    });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

export {
  authorized,
  buildStringToSign,
  buildTuyaSign,
  config,
  extractMultipartAudio,
  getDialogHistory,
  getTuyaAccessToken,
  isTuyaEnabled,
  loadDeviceMap,
  parseHomeCommand,
  parseMultipart,
  parseNote,
  resetDialogHistory,
  resetRateLimit,
  resetSpeechRegistry,
  resetTuyaTokenCache,
  route,
  server,
  settleBackgroundWrites,
  setStore,
  SAFE_INSTANT_DEVICES
};
