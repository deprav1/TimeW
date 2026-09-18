import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";

// The server persists notes to env.DATA_DIR. Point it at a throwaway
// directory *before* importing the module so we never touch
// server/data/notes.json. Also cap MAX_AUDIO_BYTES so the 413 test stays
// small and fast.
const dataDir = await mkdtemp(join(tmpdir(), "timew-test-"));
process.env.DATA_DIR = dataDir;
process.env.MAX_AUDIO_BYTES = "1024";
delete process.env.DEVICE_TOKEN;
// Force demo mode regardless of what's configured in server/.env — tests
// must never make real network calls to an AI provider.
process.env.AI_PROVIDER = "mock";
process.env.AI_API_KEY = "";
// Keep the shared instance's rate limiter effectively unlimited so the many
// requests fired across this whole suite never trip 429s; the dedicated
// rate-limit test below temporarily lowers config.rateLimitMax instead of
// relying on this env value, then restores it.
process.env.RATE_LIMIT_MAX = "1000000";
// Quiet the per-request access log during test runs.
process.env.LOG_REQUESTS = "0";

const {
  authorized,
  buildStringToSign,
  buildTuyaSign,
  config,
  extractMultipartAudio,
  getDialogHistory,
  getTuyaAccessToken,
  loadDeviceMap,
  parseHomeCommand,
  parseMultipart,
  parseNote,
  resetDialogHistory,
  settleBackgroundWrites,
  resetRateLimit,
  resetSpeechRegistry,
  resetTuyaTokenCache,
  server
} = await import("../src/server.mjs");

// Force the Tuya integration off for the whole suite by default, regardless
// of what real credentials might be configured in server/.env — tests must
// never call the real Tuya cloud. Tests that need Tuya "enabled" point
// config.tuyaAccessId/tuyaAccessSecret/tuyaBaseUrl/tuyaUid at a local mock
// HTTP server (started in-test) and restore these afterwards.
config.tuyaAccessId = "";
config.tuyaAccessSecret = "";
config.tuyaUid = "";

// Same reason, for device auth: deleting process.env.DEVICE_TOKEN above is not
// enough, because the server reads server/.env itself. On a machine where the
// gateway has actually been set up, config.token would be the real token and
// every unauthenticated request in this suite would 401. Tests that need auth
// set config.token themselves and restore it to this empty baseline.
config.token = "";

// И то же самое для озвучки. Если в server/.env включён TTS (а он там
// включается, как только человек захотел звук), synthesizeSpeech пошла бы
// к настоящему провайдеру вместо поддельного, и проверки озвучки падали бы
// только на настроенной машине. Тесты, которым озвучка нужна, задают эти
// поля сами.
config.ttsProvider = "none";
config.ttsApiKey = "";

let base;

// Builds a multipart/form-data body by hand (Buffer-only — never a string
// round-trip) so tests can exercise parseMultipart/extractMultipartAudio and
// the HTTP route with full control over headers and binary content.
function buildMultipartBody(boundary, parts) {
  const chunks = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`, "utf8"));
    let headerText = `Content-Disposition: form-data; name="${part.name}"`;
    if (part.filename) headerText += `; filename="${part.filename}"`;
    headerText += "\r\n";
    if (part.contentType) headerText += `Content-Type: ${part.contentType}\r\n`;
    headerText += "\r\n";
    chunks.push(Buffer.from(headerText, "utf8"));
    chunks.push(Buffer.isBuffer(part.body) ? part.body : Buffer.from(String(part.body), "utf8"));
    chunks.push(Buffer.from("\r\n", "utf8"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
  return Buffer.concat(chunks);
}

before(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(dataDir, { recursive: true, force: true });
});

// --- existing parser tests -------------------------------------------------

test("parses Russian notes", () => {
  assert.equal(parseNote("Запиши: купить фильтр"), "купить фильтр");
});

test("parses safe light commands", () => {
  assert.deepEqual(parseHomeCommand("выключи свет в спальне"), {
    action: "off", device: "light", room: "bedroom"
  });
});

test("does not turn arbitrary text into a home action", () => {
  assert.equal(parseHomeCommand("поставь будильник"), null);
});

// --- HTTP tests --------------------------------------------------------------

test("GET /health is public and reports demo mode", async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.mode, "demo");
  assert.equal(body.buildId, config.buildId);
});

test("GET /api/v1/status is protected and reports capabilities without secrets", async () => {
  const original = config.token;
  config.token = "status-secret";
  try {
    const denied = await fetch(`${base}/api/v1/status`);
    assert.equal(denied.status, 401);
    const res = await fetch(`${base}/api/v1/status`, { headers: { "X-TimeW-Device-Token": "status-secret" } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.mode, "demo");
    assert.equal(body.buildId, config.buildId);
    assert.equal(body.capabilities.notes, true);
    assert.equal(body.capabilities.homeConfirmation, true);
    assert.equal("apiKey" in body, false);
  } finally { config.token = original; }
});

test("query idempotency key returns the original note and does not duplicate it", async () => {
  const headers = { "Content-Type": "application/json", "Idempotency-Key": "note-once-1" };
  const first = await fetch(`${base}/api/v1/query`, { method: "POST", headers, body: JSON.stringify({ text: "Запиши: idempotent note" }) });
  const second = await fetch(`${base}/api/v1/query`, { method: "POST", headers, body: JSON.stringify({ text: "Запиши: idempotent note" }) });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  const a = await first.json();
  const b = await second.json();
  assert.equal(a.note.id, b.note.id);
  const notes = await (await fetch(`${base}/api/v1/notes?limit=50`)).json();
  assert.equal(notes.notes.filter((note) => note.id === a.note.id).length, 1);
});

test("a confirmation token is single-use", async () => {
  await withMockTuya(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && url.pathname === "/v1.0/token") return tokenHandler("tok-confirm")(res);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, result: true }));
  }, async () => {
    await writeFile(devicesJsonPath, JSON.stringify({ bedroom: ["dev-confirm"] }), "utf8");
    const prepared = await fetch(`${base}/api/v1/query`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "включи свет в спальне" }) });
    const body = await prepared.json();
    const first = await fetch(`${base}/api/v1/home/confirm`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmationToken: body.confirmationToken }) });
    const second = await fetch(`${base}/api/v1/home/confirm`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmationToken: body.confirmationToken }) });
    assert.equal(first.status, 200);
    assert.equal(second.status, 410);
  });
});

test("POST /api/v1/query with a note creates a note visible via GET /api/v1/notes", async () => {
  const res = await fetch(`${base}/api/v1/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "Запиши: купить хлеб" })
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.kind, "note");
  assert.equal(body.note.text, "купить хлеб");

  const listRes = await fetch(`${base}/api/v1/notes`);
  const listBody = await listRes.json();
  assert.equal(listRes.status, 200);
  assert.ok(listBody.notes.some((n) => n.id === body.note.id));
});

test("POST /api/v1/query with a home command requires confirmation and does not execute", async () => {
  const res = await fetch(`${base}/api/v1/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "выключи свет в спальне" })
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.kind, "home");
  assert.equal(body.requiresConfirmation, true);
  assert.equal(body.executed, false);
  assert.deepEqual(body.command, { action: "off", device: "light", room: "bedroom" });
});

test("POST /api/v1/query with a plain question falls back to the demo AI provider", async () => {
  const res = await fetch(`${base}/api/v1/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "Какая сегодня погода?" })
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.kind, "ai");
  assert.equal(body.source, "demo");
});

test("POST /api/v1/query with empty text returns 400", async () => {
  const res = await fetch(`${base}/api/v1/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "   " })
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
});

test("POST /api/v1/query with invalid JSON returns 400", async () => {
  const res = await fetch(`${base}/api/v1/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{not-json"
  });
  assert.equal(res.status, 400);
});

test("GET /api/v1/notes?limit=2 returns at most 2 notes", async () => {
  for (const text of ["Запиши: заметка один", "Запиши: заметка два", "Запиши: заметка три"]) {
    await fetch(`${base}/api/v1/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text })
    });
  }
  const res = await fetch(`${base}/api/v1/notes?limit=2`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.notes.length <= 2);
});

test("GET /api/v1/notes with an invalid limit returns 400", async () => {
  const res = await fetch(`${base}/api/v1/notes?limit=abc`);
  assert.equal(res.status, 400);
  const zeroRes = await fetch(`${base}/api/v1/notes?limit=0`);
  assert.equal(zeroRes.status, 400);
});

test("GET /api/v1/notes?limit=3 with a query string does not 404 (routing regression)", async () => {
  const res = await fetch(`${base}/api/v1/notes?limit=3`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.ok(body.notes.length <= 3);
});

test("DELETE /api/v1/notes/:id removes a note; a second delete 404s", async () => {
  const createRes = await fetch(`${base}/api/v1/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "Запиши: заметка для удаления" })
  });
  const { note } = await createRes.json();

  const deleteRes = await fetch(`${base}/api/v1/notes/${note.id}`, { method: "DELETE" });
  assert.equal(deleteRes.status, 200);
  const deleteBody = await deleteRes.json();
  assert.deepEqual(deleteBody, { ok: true, deleted: true, id: note.id });

  const secondDeleteRes = await fetch(`${base}/api/v1/notes/${note.id}`, { method: "DELETE" });
  assert.equal(secondDeleteRes.status, 404);
  const secondDeleteBody = await secondDeleteRes.json();
  assert.equal(secondDeleteBody.error.code, "not_found");
});

// --- multipart parsing (unit) -------------------------------------------------

test("parseMultipart extracts a text field and a file part with their headers", () => {
  const boundary = "TestBoundary123";
  const body = buildMultipartBody(boundary, [
    { name: "note", body: "hello" },
    { name: "audio", filename: "clip.opus", contentType: "audio/opus", body: Buffer.from([1, 2, 3, 4]) }
  ]);
  const parts = parseMultipart(body, boundary);
  assert.equal(parts.length, 2);
  assert.equal(parts[0].name, "note");
  assert.equal(parts[0].filename, undefined);
  assert.equal(parts[0].body.toString("utf8"), "hello");
  assert.equal(parts[1].name, "audio");
  assert.equal(parts[1].filename, "clip.opus");
  assert.equal(parts[1].contentType, "audio/opus");
  assert.deepEqual([...parts[1].body], [1, 2, 3, 4]);
});

test("parseMultipart preserves binary bytes that are invalid UTF-8 (regression: no string round-trip)", () => {
  const boundary = "BinBoundary456";
  const invalidUtf8 = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x01]);
  const body = buildMultipartBody(boundary, [
    { name: "audio", filename: "clip.pcm", body: invalidUtf8 }
  ]);
  const parts = parseMultipart(body, boundary);
  assert.equal(parts.length, 1);
  assert.ok(Buffer.compare(parts[0].body, invalidUtf8) === 0, "file part bytes must match exactly, byte-for-byte");
});

test("extractMultipartAudio falls back to extension-based Content-Type when the part has none", () => {
  const boundary = "ExtBoundary789";
  const body = buildMultipartBody(boundary, [
    { name: "audio", filename: "clip.wav", body: Buffer.from([9, 9, 9]) }
  ]);
  const result = extractMultipartAudio(body, `multipart/form-data; boundary=${boundary}`);
  assert.equal(result.contentType, "audio/wav");
  assert.deepEqual([...result.bytes], [9, 9, 9]);
});

test("extractMultipartAudio throws a 400 when no part has a filename", () => {
  const boundary = "NoFileBoundary";
  const body = buildMultipartBody(boundary, [{ name: "note", body: "just text, no file" }]);
  assert.throws(
    () => extractMultipartAudio(body, `multipart/form-data; boundary=${boundary}`),
    (cause) => cause.statusCode === 400
  );
});

// --- multipart transcription (HTTP) -------------------------------------------

test("POST /api/v1/transcribe accepts a multipart/form-data body and returns 200", async () => {
  const boundary = "HttpBoundaryABC";
  const body = buildMultipartBody(boundary, [
    { name: "audio", filename: "clip.opus", contentType: "audio/opus", body: Buffer.from([1, 2, 3, 4, 5]) }
  ]);
  const res = await fetch(`${base}/api/v1/transcribe`, {
    method: "POST",
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body
  });
  assert.equal(res.status, 200);
  const responseBody = await res.json();
  assert.equal(responseBody.ok, true);
  assert.equal(responseBody.source, "demo");
});

test("POST /api/v1/transcribe with multipart but no file part returns 400", async () => {
  const boundary = "HttpBoundaryNoFile";
  const body = buildMultipartBody(boundary, [{ name: "note", body: "no file here" }]);
  const res = await fetch(`${base}/api/v1/transcribe`, {
    method: "POST",
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body
  });
  assert.equal(res.status, 400);
});

test("POST /api/v1/transcribe with garbage multipart body (no boundary in header) returns 400, not 500", async () => {
  const res = await fetch(`${base}/api/v1/transcribe`, {
    method: "POST",
    headers: { "Content-Type": "multipart/form-data" },
    body: Buffer.from("this is not a valid multipart body at all")
  });
  assert.equal(res.status, 400);
});

test("POST /api/v1/transcribe with garbage multipart body (boundary present but body malformed) returns 400, not 500", async () => {
  const res = await fetch(`${base}/api/v1/transcribe`, {
    method: "POST",
    headers: { "Content-Type": "multipart/form-data; boundary=Whatever" },
    body: Buffer.from("garbage garbage garbage, no boundaries in here")
  });
  assert.equal(res.status, 400);
});

test("POST /api/v1/transcribe with a raw binary body (existing path) still returns 200 (regression)", async () => {
  const res = await fetch(`${base}/api/v1/transcribe`, {
    method: "POST",
    headers: { "Content-Type": "audio/opus" },
    body: Buffer.from([1, 2, 3, 4, 5, 6])
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.source, "demo");
});

test("POST /api/v1/transcribe rejects an oversized multipart body with 413", async () => {
  const boundary = "HttpBoundaryBig";
  const oversized = Buffer.alloc(Number(process.env.MAX_AUDIO_BYTES) + 1, 7);
  const body = buildMultipartBody(boundary, [
    { name: "audio", filename: "clip.pcm", body: oversized }
  ]);
  const res = await fetch(`${base}/api/v1/transcribe`, {
    method: "POST",
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body
  });
  assert.equal(res.status, 413);
});

test("POST /api/v1/transcribe rejects bodies over MAX_AUDIO_BYTES with 413", async () => {
  const oversized = Buffer.alloc(Number(process.env.MAX_AUDIO_BYTES) + 1, 1);
  const res = await fetch(`${base}/api/v1/transcribe`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: oversized
  });
  assert.equal(res.status, 413);
});

test("POST /api/v1/transcribe rejects an empty body with 400", async () => {
  const res = await fetch(`${base}/api/v1/transcribe`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: Buffer.alloc(0)
  });
  assert.equal(res.status, 400);
});

test("unknown paths return 404 with code not_found", async () => {
  const res = await fetch(`${base}/nope`);
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.error.code, "not_found");
});

test("OPTIONS returns 204 with no body and CORS headers", async () => {
  const res = await fetch(`${base}/api/v1/notes`, { method: "OPTIONS" });
  assert.equal(res.status, 204);
  const text = await res.text();
  assert.equal(text, "");
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  assert.equal(res.headers.get("access-control-allow-methods"), "GET, POST, DELETE, OPTIONS");
  assert.equal(res.headers.get("access-control-allow-headers"), "Content-Type, X-TimeW-Device-Token, Idempotency-Key, X-TimeW-Request-Id");
  assert.equal(res.headers.get("access-control-max-age"), "86400");
});

// --- token auth (config.token is mutated for the duration of these tests) --

test("requests without a valid device token are rejected once a token is configured", async (t) => {
  const original = config.token;
  config.token = "s3cr3t-device-token";
  t.after(() => { config.token = original; });

  const noHeader = await fetch(`${base}/api/v1/notes`);
  assert.equal(noHeader.status, 401);

  const wrongHeader = await fetch(`${base}/api/v1/notes`, {
    headers: { "X-TimeW-Device-Token": "wrong" }
  });
  assert.equal(wrongHeader.status, 401);

  const rightHeader = await fetch(`${base}/api/v1/notes`, {
    headers: { "X-TimeW-Device-Token": "s3cr3t-device-token" }
  });
  assert.equal(rightHeader.status, 200);

  // /health stays public even with a token configured.
  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);
});

test("authorized() performs a length-safe comparison directly", () => {
  const original = config.token;
  config.token = "abc";
  try {
    assert.equal(authorized({ headers: {} }), false);
    assert.equal(authorized({ headers: { "x-timew-device-token": "abcd" } }), false);
    assert.equal(authorized({ headers: { "x-timew-device-token": "ab" } }), false);
    assert.equal(authorized({ headers: { "x-timew-device-token": "abc" } }), true);
  } finally {
    config.token = original;
  }
});

// --- rate limiting -----------------------------------------------------------

test("exceeding the rate limit returns 429 with code rate_limited", async (t) => {
  // Temporarily give this instance a tiny limit instead of relying on the
  // suite-wide RATE_LIMIT_MAX env value (kept huge so the rest of the suite
  // never trips it). We reset counters before and after so this test can't
  // leak state into — or be affected by — any other test's requests.
  const originalMax = config.rateLimitMax;
  const originalWindow = config.rateLimitWindowMs;
  config.rateLimitMax = 3;
  config.rateLimitWindowMs = 60000;
  resetRateLimit();
  t.after(() => {
    config.rateLimitMax = originalMax;
    config.rateLimitWindowMs = originalWindow;
    resetRateLimit();
  });

  const statuses = [];
  for (let i = 0; i < 4; i += 1) {
    const res = await fetch(`${base}/health`);
    statuses.push(res.status);
    if (res.status === 429) {
      const body = await res.json();
      assert.equal(body.error.code, "rate_limited");
    }
  }
  assert.deepEqual(statuses, [200, 200, 200, 429]);
});

// --- notes persistence robustness --------------------------------------------

test("saving a note never leaves a notes.json.tmp file behind", async () => {
  await fetch(`${base}/api/v1/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "Запиши: проверка атомарной записи" })
  });
  assert.equal(existsSync(join(dataDir, "notes.json.tmp")), false);
});

test("a corrupted notes.json is quarantined and GET /api/v1/notes still returns 200", async () => {
  const notesPath = join(dataDir, "notes.json");
  await writeFile(notesPath, "{not valid json", "utf8");

  const res = await fetch(`${base}/api/v1/notes`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.notes, []);

  const entries = await readdir(dataDir);
  assert.ok(entries.some((name) => name.startsWith("notes.json.corrupt.")), "expected a quarantined notes.json.corrupt.* file");
  assert.equal(entries.includes("notes.json"), false);
});

// --- provider timeout / network-failure handling -----------------------------

test("a hung AI provider is aborted after providerTimeoutMs and returns 504 provider_error", async (t) => {
  // A raw HTTP server that accepts the connection but never responds,
  // simulating a provider that hangs — entirely local, no network egress.
  const stuck = http.createServer(() => {});
  await new Promise((resolve) => stuck.listen(0, "127.0.0.1", resolve));
  const { port } = stuck.address();

  const originalProvider = config.provider;
  const originalApiKey = config.apiKey;
  const originalBaseUrl = config.baseUrl;
  const originalTimeout = config.providerTimeoutMs;
  config.provider = "openai-compatible";
  config.apiKey = "test-key";
  config.baseUrl = `http://127.0.0.1:${port}`;
  config.providerTimeoutMs = 150;
  t.after(async () => {
    config.provider = originalProvider;
    config.apiKey = originalApiKey;
    config.baseUrl = originalBaseUrl;
    config.providerTimeoutMs = originalTimeout;
    await new Promise((resolve) => stuck.close(resolve));
  });

  const res = await fetch(`${base}/api/v1/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "Какая сейчас погода в Берлине?" })
  });
  assert.equal(res.status, 504);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "provider_error");
});

test("an unreachable AI provider returns 502 provider_error, not a bare 500", async (t) => {
  // Bind then immediately close a server to grab a port nothing is
  // listening on, so the fetch fails fast with ECONNREFUSED.
  const probe = http.createServer(() => {});
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));

  const originalProvider = config.provider;
  const originalApiKey = config.apiKey;
  const originalBaseUrl = config.baseUrl;
  config.provider = "openai-compatible";
  config.apiKey = "test-key";
  config.baseUrl = `http://127.0.0.1:${port}`;
  t.after(() => {
    config.provider = originalProvider;
    config.apiKey = originalApiKey;
    config.baseUrl = originalBaseUrl;
  });

  const res = await fetch(`${base}/api/v1/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "Расскажи короткий факт" })
  });
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "provider_error");
});

// --- Tuya Cloud integration ---------------------------------------------------

const devicesJsonPath = join(dataDir, "devices.json");

async function withMockTuya(handler, run) {
  const mock = http.createServer(handler);
  await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
  const { port } = mock.address();
  const original = {
    id: config.tuyaAccessId,
    secret: config.tuyaAccessSecret,
    baseUrl: config.tuyaBaseUrl,
    uid: config.tuyaUid
  };
  config.tuyaAccessId = "test-access-id";
  config.tuyaAccessSecret = "test-access-secret";
  config.tuyaBaseUrl = `http://127.0.0.1:${port}`;
  resetTuyaTokenCache();
  try {
    return await run();
  } finally {
    config.tuyaAccessId = original.id;
    config.tuyaAccessSecret = original.secret;
    config.tuyaBaseUrl = original.baseUrl;
    config.tuyaUid = original.uid;
    resetTuyaTokenCache();
    await rm(devicesJsonPath, { force: true });
    await new Promise((resolve) => mock.close(resolve));
  }
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function tokenHandler(accessToken = "tok-test") {
  return (res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, result: { access_token: accessToken, expire_time: 7200 } }));
  };
}

test("buildStringToSign matches Tuya's documented stringToSign structure for a token request", () => {
  const stringToSign = buildStringToSign({ method: "GET", body: "", url: "/v1.0/token?grant_type=1" });
  // SHA256("") is a well-known constant, also the one used in Tuya's own
  // signing documentation example.
  assert.equal(
    stringToSign,
    "GET\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\n\n/v1.0/token?grant_type=1"
  );
});

test("buildTuyaSign: token signature excludes access_token, business signature includes it (regression pin)", () => {
  const stringToSign = "GET\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\n\n/v1.0/token?grant_type=1";
  const clientId = "abc123";
  const secret = "s3cr3t";
  const t = "1700000000000";
  const nonce = "fixed-nonce";

  const tokenSign = buildTuyaSign({ clientId, secret, t, nonce, stringToSign });
  const expectedTokenSign = createHmac("sha256", secret)
    .update(`${clientId}${t}${nonce}${stringToSign}`, "utf8")
    .digest("hex")
    .toUpperCase();
  assert.equal(tokenSign, expectedTokenSign);
  assert.equal(tokenSign, tokenSign.toUpperCase(), "sign must be uppercase hex");

  const businessSign = buildTuyaSign({ clientId, secret, t, nonce, accessToken: "tok-xyz", stringToSign });
  const expectedBusinessSign = createHmac("sha256", secret)
    .update(`${clientId}tok-xyz${t}${nonce}${stringToSign}`, "utf8")
    .digest("hex")
    .toUpperCase();
  assert.equal(businessSign, expectedBusinessSign);
  assert.notEqual(businessSign, tokenSign, "including access_token must change the signature");
});

test("parseHomeCommand recognizes unsafe device classes (e.g. socket) distinctly from light", () => {
  assert.deepEqual(parseHomeCommand("включи розетку на кухне"), { action: "on", device: "socket", room: "kitchen" });
  assert.deepEqual(parseHomeCommand("выключи замок в спальне"), { action: "off", device: "lock", room: "bedroom" });
});

test("getTuyaAccessToken fetches once and caches on a second call", async () => {
  let tokenCalls = 0;
  await withMockTuya(
    (req, res) => {
      tokenCalls += 1;
      tokenHandler("tok-cache")(res);
    },
    async () => {
      const first = await getTuyaAccessToken();
      const second = await getTuyaAccessToken();
      assert.equal(first, "tok-cache");
      assert.equal(second, "tok-cache");
      assert.equal(tokenCalls, 1, "the token endpoint must be hit only once while the cached token is still valid");
    }
  );
});

test("POST /api/v1/query executes a light command via Tuya when devices.json maps the room", async () => {
  const commandCalls = [];
  await withMockTuya(
    async (req, res) => {
      const url = new URL(req.url, "http://localhost");
      if (req.method === "GET" && url.pathname === "/v1.0/token") return tokenHandler("tok-exec")(res);
      if (req.method === "POST" && url.pathname === "/v1.0/iot-03/devices/dev-1/commands") {
        commandCalls.push(await readJsonBody(req));
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ success: true, result: true }));
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, code: 404, msg: "unexpected path" }));
    },
    async () => {
      await writeFile(devicesJsonPath, JSON.stringify({ bedroom: ["dev-1"] }), "utf8");
      const res = await fetch(`${base}/api/v1/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "выключи свет в спальне" })
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.kind, "home");
      assert.equal(body.executed, false);
      assert.equal(body.requiresConfirmation, true);
      assert.equal(commandCalls.length, 0, "preparation must not call Tuya");
      const confirm = await fetch(`${base}/api/v1/home/confirm`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmationToken: body.confirmationToken })
      });
      assert.equal(confirm.status, 200);
      const confirmed = await confirm.json();
      assert.equal(confirmed.executed, true);
      assert.equal(confirmed.text, "Выключил свет в спальне");
      assert.deepEqual(confirmed.devices, ["dev-1"]);
      assert.equal(commandCalls.length, 1, "expected exactly one POST commands call");
      assert.deepEqual(commandCalls[0], { commands: [{ code: "switch_led", value: false }] });
    }
  );
});

test("POST /api/v1/query with an unrecognized room does not execute and never calls Tuya", async () => {
  let tuyaCalls = 0;
  await withMockTuya(
    (req, res) => {
      tuyaCalls += 1;
      res.writeHead(500);
      res.end();
    },
    async () => {
      const res = await fetch(`${base}/api/v1/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "выключи свет" })
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.executed, false);
      assert.equal(body.requiresConfirmation, true);
      assert.equal(body.command.room, null);
      assert.equal(tuyaCalls, 0, "no room recognized — Tuya must never be contacted");
    }
  );
});

test("POST /api/v1/query with Tuya configured but no devices.json returns a clear message, not a 500", async () => {
  await withMockTuya(
    (req, res) => {
      res.writeHead(500);
      res.end();
    },
    async () => {
      await rm(devicesJsonPath, { force: true });
      const res = await fetch(`${base}/api/v1/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "включи свет на кухне" })
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.executed, false);
      assert.equal(body.requiresConfirmation, true);
      assert.match(body.text, /devices\.json/);
    }
  );
});

test("POST /api/v1/query with Tuya not configured keeps the previous behaviour (executed:false)", async () => {
  // Baseline for the whole suite already has Tuya disabled (see top of
  // file), so this just re-confirms the contract explicitly.
  const res = await fetch(`${base}/api/v1/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "включи свет в кухне" })
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.kind, "home");
  assert.equal(body.executed, false);
  assert.equal(body.requiresConfirmation, true);
});

test("a command for an unsafe device class (socket) is never executed even when Tuya is configured", async () => {
  let tuyaCalls = 0;
  await withMockTuya(
    (req, res) => {
      tuyaCalls += 1;
      res.writeHead(500);
      res.end();
    },
    async () => {
      await writeFile(devicesJsonPath, JSON.stringify({ kitchen: ["dev-socket"] }), "utf8");
      const res = await fetch(`${base}/api/v1/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "включи розетку на кухне" })
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.kind, "home");
      assert.equal(body.command.device, "socket");
      assert.equal(body.executed, false);
      assert.equal(body.requiresConfirmation, true);
      assert.equal(tuyaCalls, 0, "an unsafe device class must never reach Tuya, regardless of configuration");
    }
  );
});

test("GET /api/v1/home/devices returns 503 with a clear message when Tuya is not configured", async () => {
  const res = await fetch(`${base}/api/v1/home/devices`);
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "tuya_disabled");
});

test("GET /api/v1/home/devices returns the device list and room map when Tuya is configured", async () => {
  await withMockTuya(
    async (req, res) => {
      const url = new URL(req.url, "http://localhost");
      if (req.method === "GET" && url.pathname === "/v1.0/token") return tokenHandler("tok-list")(res);
      if (req.method === "GET" && url.pathname === "/v1.0/users/uid-1/devices") {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({
          success: true,
          result: [{ id: "dev-1", name: "Лампа в спальне", category: "dj", online: true }]
        }));
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, code: 404, msg: "unexpected path" }));
    },
    async () => {
      config.tuyaUid = "uid-1";
      await writeFile(devicesJsonPath, JSON.stringify({ bedroom: ["dev-1"] }), "utf8");
      const res = await fetch(`${base}/api/v1/home/devices`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.deepEqual(body.devices, [{ id: "dev-1", name: "Лампа в спальне", category: "dj", online: true }]);
      assert.deepEqual(body.rooms, { bedroom: ["dev-1"] });
    }
  );
});

test("GET /api/v1/home/devices without TUYA_UID returns 503, not a 500", async () => {
  await withMockTuya(
    (req, res) => {
      res.writeHead(500);
      res.end();
    },
    async () => {
      // config.tuyaUid stays "" (never set for this test).
      const res = await fetch(`${base}/api/v1/home/devices`);
      assert.equal(res.status, 503);
      const body = await res.json();
      assert.equal(body.error.code, "tuya_disabled");
    }
  );
});

test("a Tuya HTTP failure (unreachable service) surfaces as 502 provider_error, not a bare 500", async () => {
  const probe = http.createServer(() => {});
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));

  const original = {
    id: config.tuyaAccessId,
    secret: config.tuyaAccessSecret,
    baseUrl: config.tuyaBaseUrl,
    uid: config.tuyaUid
  };
  config.tuyaAccessId = "id-unreachable";
  config.tuyaAccessSecret = "secret-unreachable";
  config.tuyaBaseUrl = `http://127.0.0.1:${port}`;
  config.tuyaUid = "uid-x";
  resetTuyaTokenCache();
  try {
    const res = await fetch(`${base}/api/v1/home/devices`);
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error.code, "provider_error");
  } finally {
    config.tuyaAccessId = original.id;
    config.tuyaAccessSecret = original.secret;
    config.tuyaBaseUrl = original.baseUrl;
    config.tuyaUid = original.uid;
    resetTuyaTokenCache();
  }
});

test("a Tuya API-level error (e.g. device offline) surfaces as a clear 502, not a bare 500", async () => {
  await withMockTuya(
    async (req, res) => {
      const url = new URL(req.url, "http://localhost");
      if (req.method === "GET" && url.pathname === "/v1.0/token") return tokenHandler("tok-offline")(res);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, code: 2007, msg: "device offline" }));
    },
    async () => {
      await writeFile(devicesJsonPath, JSON.stringify({ kitchen: ["dev-off"] }), "utf8");
      const prepared = await fetch(`${base}/api/v1/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "включи свет на кухне" })
      });
      assert.equal(prepared.status, 200);
      const preparedBody = await prepared.json();
      const res = await fetch(`${base}/api/v1/home/confirm`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmationToken: preparedBody.confirmationToken })
      });
      assert.equal(res.status, 502);
      const body = await res.json();
      assert.equal(body.ok, false);
      assert.equal(body.error.code, "provider_error");
      assert.match(body.error.message, /device offline/);
    }
  );
});

test("loadDeviceMap returns null when devices.json is absent (no crash)", async () => {
  await rm(devicesJsonPath, { force: true });
  const result = await loadDeviceMap();
  assert.equal(result, null);
});

// --- /api/v1/voice, dialog memory, provider selection, /api/v1/speak --------
//
// Shared mock helpers, mirroring withMockTuya above: point config at a local
// HTTP server instead of the real Gemini/OpenAI endpoints, and always
// restore config afterwards so state never leaks between tests.

async function withMockGemini(handler, run) {
  const mock = http.createServer(handler);
  await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
  const { port } = mock.address();
  const original = { apiKey: config.apiKey, geminiBaseUrl: config.geminiBaseUrl };
  config.apiKey = "test-gemini-key";
  config.geminiBaseUrl = `http://127.0.0.1:${port}`;
  try {
    return await run();
  } finally {
    config.apiKey = original.apiKey;
    config.geminiBaseUrl = original.geminiBaseUrl;
    await new Promise((resolve) => mock.close(resolve));
  }
}

async function withMockOpenAI(handler, run, { provider = "openai-compatible" } = {}) {
  const mock = http.createServer(handler);
  await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
  const { port } = mock.address();
  const original = { apiKey: config.apiKey, baseUrl: config.baseUrl, provider: config.provider };
  config.apiKey = "test-openai-key";
  config.baseUrl = `http://127.0.0.1:${port}`;
  config.provider = provider;
  try {
    return await run();
  } finally {
    config.apiKey = original.apiKey;
    config.baseUrl = original.baseUrl;
    config.provider = original.provider;
    await new Promise((resolve) => mock.close(resolve));
  }
}

function geminiVoiceHandler({ transcript, answer }) {
  return (req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify({ transcript, answer }) }] } }]
    }));
  };
}

function geminiChatHandler(text) {
  return (req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }));
  };
}

test.beforeEach(async () => {
  await resetDialogHistory();
});

// --- /api/v1/voice ------------------------------------------------------------

test("POST /api/v1/voice with a raw body in demo mode returns transcript + AI text", async () => {
  const res = await fetch(`${base}/api/v1/voice`, {
    method: "POST",
    headers: { "Content-Type": "audio/opus" },
    body: Buffer.from([1, 2, 3, 4, 5])
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.kind, "ai");
  assert.ok(body.transcript, "expected a non-empty transcript");
  assert.ok(body.text, "expected a non-empty text");
  assert.equal(body.source, "demo");
});

test("POST /api/v1/voice accepts a multipart/form-data body (reuses the same parser as /transcribe)", async () => {
  const boundary = "VoiceBoundaryABC";
  const requestBody = buildMultipartBody(boundary, [
    { name: "audio", filename: "clip.opus", contentType: "audio/opus", body: Buffer.from([9, 8, 7, 6]) }
  ]);
  const res = await fetch(`${base}/api/v1/voice`, {
    method: "POST",
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body: requestBody
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.kind, "ai");
  assert.ok(body.transcript);
});

test("POST /api/v1/voice recognizes a note in the transcript: kind note, note persisted, no AI answer used", async () => {
  const originalDemo = config.provider;
  // Demo transcription always returns the same fixed sentence, which isn't
  // a note. To exercise the note branch we point demoTranscript-independent
  // logic by using the mock OpenAI transcription path with a canned
  // response instead.
  await withMockOpenAI(
    (req, res) => {
      const url = new URL(req.url, "http://localhost");
      res.writeHead(200, { "Content-Type": "application/json" });
      if (url.pathname === "/audio/transcriptions") {
        return res.end(JSON.stringify({ text: "Запиши: купить молоко" }));
      }
      // Chat completion must never be called for a note.
      res.writeHead(500);
      res.end();
    },
    async () => {
      const res = await fetch(`${base}/api/v1/voice`, {
        method: "POST",
        headers: { "Content-Type": "audio/opus" },
        body: Buffer.from([1, 2, 3])
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.kind, "note");
      assert.equal(body.note.text, "купить молоко");
      assert.equal(body.transcript, "Запиши: купить молоко");

      const listRes = await fetch(`${base}/api/v1/notes?limit=1`);
      const listBody = await listRes.json();
      assert.equal(listBody.notes[0].id, body.note.id);
    }
  );
  assert.equal(config.provider, originalDemo);
});

test("POST /api/v1/voice?intent=note saves the transcript as a note even without the word «Запиши»", async () => {
  // На часах нет ввода текста, поэтому заметка надиктовывается, и кнопка
  // «Заметка» передаёт намерение явно — иначе пришлось бы каждый раз
  // проговаривать «запиши».
  await withMockOpenAI(
    (req, res) => {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname === "/audio/transcriptions") {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ text: "купить фильтр для воды" }));
      }
      // Ответ модели для заметки не нужен и запрашиваться не должен.
      res.writeHead(500);
      res.end();
    },
    async () => {
      const res = await fetch(`${base}/api/v1/voice?intent=note`, {
        method: "POST",
        headers: { "Content-Type": "audio/opus" },
        body: Buffer.from([1, 2, 3])
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.kind, "note");
      assert.equal(body.note.text, "купить фильтр для воды");
      assert.equal(body.transcript, "купить фильтр для воды");
    }
  );
});

test("POST /api/v1/voice?intent=note&preview=1 returns a draft without saving", async () => {
  const before = await fetch(`${base}/api/v1/notes?limit=50`);
  const beforeBody = await before.json();
  const res = await fetch(`${base}/api/v1/voice?intent=note&preview=1`, {
    method: "POST",
    headers: { "Content-Type": "audio/opus" },
    body: Buffer.from([1, 2, 3])
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.kind, "draft");
  assert.ok(body.transcript);
  const after = await fetch(`${base}/api/v1/notes?limit=50`);
  const afterBody = await after.json();
  assert.equal(afterBody.notes.length, beforeBody.notes.length);
});

test("intent=note не даёт исполнять домашние команды: приоритет у явного намерения заметки", async () => {
  // Защита от подмены смысла: даже если надиктовано похожее на команду,
  // при intent=note это должно стать заметкой, а не действием.
  await withMockOpenAI(
    (req, res) => {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname === "/audio/transcriptions") {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ text: "выключи свет в спальне" }));
      }
      res.writeHead(500);
      res.end();
    },
    async () => {
      const res = await fetch(`${base}/api/v1/voice?intent=note`, {
        method: "POST",
        headers: { "Content-Type": "audio/opus" },
        body: Buffer.from([1, 2, 3])
      });
      const body = await res.json();
      assert.equal(body.kind, "note");
      assert.equal(body.executed, undefined);
    }
  );
});

test("POST /api/v1/voice recognizes a home command in the transcript: kind home, confirmation policy respected", async () => {
  await withMockOpenAI(
    (req, res) => {
      const url = new URL(req.url, "http://localhost");
      res.writeHead(200, { "Content-Type": "application/json" });
      if (url.pathname === "/audio/transcriptions") {
        return res.end(JSON.stringify({ text: "выключи свет в спальне" }));
      }
      res.writeHead(500);
      res.end();
    },
    async () => {
      const res = await fetch(`${base}/api/v1/voice`, {
        method: "POST",
        headers: { "Content-Type": "audio/opus" },
        body: Buffer.from([1, 2, 3])
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.kind, "home");
      assert.equal(body.requiresConfirmation, true);
      assert.equal(body.executed, false);
      assert.deepEqual(body.command, { action: "off", device: "light", room: "bedroom" });
    }
  );
});

// --- Gemini single-call optimization ------------------------------------------

test("POST /api/v1/voice with a plain question makes exactly ONE Gemini call and uses its answer", async () => {
  let calls = 0;
  await withMockGemini(
    (req, res) => {
      calls += 1;
      geminiVoiceHandler({ transcript: "Какая погода?", answer: "Сегодня солнечно." })(req, res);
    },
    async () => {
      const res = await fetch(`${base}/api/v1/voice?provider=gemini`, {
        method: "POST",
        headers: { "Content-Type": "audio/opus" },
        body: Buffer.from([1, 2, 3])
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.kind, "ai");
      assert.equal(body.transcript, "Какая погода?");
      assert.equal(body.text, "Сегодня солнечно.");
      assert.equal(body.source, "gemini");
      assert.equal(calls, 1, "expected exactly one call to the Gemini mock");
    }
  );
});

test("POST /api/v1/voice with Gemini: a note transcript discards the model's answer and saves the transcript", async () => {
  await withMockGemini(
    geminiVoiceHandler({ transcript: "Запиши: полить цветы", answer: "Этот ответ не должен использоваться." }),
    async () => {
      const res = await fetch(`${base}/api/v1/voice?provider=gemini`, {
        method: "POST",
        headers: { "Content-Type": "audio/opus" },
        body: Buffer.from([1, 2, 3])
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.kind, "note");
      assert.equal(body.note.text, "полить цветы");
      assert.equal(body.transcript, "Запиши: полить цветы");
      assert.notEqual(body.text, "Этот ответ не должен использоваться.");
    }
  );
});

// --- dialog memory -------------------------------------------------------------

test("dialog memory: a second query sees the first exchange in the provider's messages", async () => {
  const seenMessages = [];
  await withMockOpenAI(
    (req, res) => {
      readJsonBody(req).then((payload) => {
        seenMessages.push(payload.messages);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: `ответ ${seenMessages.length}` } }] }));
      });
    },
    async () => {
      const first = await fetch(`${base}/api/v1/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Столица Франции?" })
      });
      assert.equal((await first.json()).text, "ответ 1");

      const second = await fetch(`${base}/api/v1/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "А подробнее?" })
      });
      assert.equal((await second.json()).text, "ответ 2");

      assert.equal(seenMessages[0].length, 2, "first call has no history yet (system + user)");
      const secondMessages = seenMessages[1];
      assert.ok(secondMessages.some((m) => m.role === "user" && m.content === "Столица Франции?"));
      assert.ok(secondMessages.some((m) => m.role === "assistant" && m.content === "ответ 1"));
    }
  );

  const resetRes = await fetch(`${base}/api/v1/dialog/reset`, { method: "POST" });
  assert.equal(resetRes.status, 200);
  const resetBody = await resetRes.json();
  assert.equal(resetBody.ok, true);
  assert.ok(resetBody.cleared >= 1);
  await settleBackgroundWrites();
  assert.deepEqual(await getDialogHistory(), []);
});

test("dialog memory: notes and home commands never enter the history", async () => {
  await fetch(`${base}/api/v1/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "Запиши: история не должна это видеть" })
  });
  await fetch(`${base}/api/v1/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "включи свет на кухне" })
  });
  await settleBackgroundWrites();
  assert.deepEqual(await getDialogHistory(), []);
});

test("dialog memory: a turn older than DIALOG_TTL_MS is not mixed into the context", async () => {
  const originalTtl = config.dialogTtlMs;
  config.dialogTtlMs = 20;
  try {
    await fetch(`${base}/api/v1/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Первый вопрос" })
    });
    await settleBackgroundWrites();
    assert.equal((await getDialogHistory()).length, 1);
    await new Promise((resolve) => setTimeout(resolve, 40));
    await settleBackgroundWrites();
    assert.deepEqual(await getDialogHistory(), [], "the stale turn must be filtered out by TTL");
  } finally {
    config.dialogTtlMs = originalTtl;
    await resetDialogHistory();
  }
});

// --- provider selection --------------------------------------------------------

test("POST /api/v1/query with provider:gemini uses the configured Gemini mock", async () => {
  await withMockGemini(
    geminiChatHandler("Ответ от Gemini"),
    async () => {
      const res = await fetch(`${base}/api/v1/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Привет", provider: "gemini" })
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.kind, "ai");
      assert.equal(body.source, "gemini");
      assert.equal(body.text, "Ответ от Gemini");
    }
  );
});

test("POST /api/v1/query with an unknown provider value returns 400", async () => {
  const res = await fetch(`${base}/api/v1/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "Привет", provider: "totally-bogus" })
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
});

test("POST /api/v1/query requesting a provider with no configured key returns 503, not a silent demo fallback", async () => {
  // Baseline suite config has AI_API_KEY = "", so requesting "openai" or
  // "gemini" explicitly must be refused rather than quietly answered by demo.
  const res = await fetch(`${base}/api/v1/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "Привет", provider: "openai" })
  });
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.match(body.error.message, /не настроен/i);
});

// --- /api/v1/speak ---------------------------------------------------------------

test("POST /api/v1/speak without a configured provider/key returns 503", async () => {
  const res = await fetch(`${base}/api/v1/speak`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "Привет" })
  });
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.ok, false);
});

test("POST /api/v1/speak with a mock TTS provider streams back audio/mpeg", async () => {
  const fakeAudio = Buffer.from([0xff, 0xfb, 0x90, 0x00, 1, 2, 3, 4]);
  await withMockOpenAI(
    (req, res) => {
      res.writeHead(200, { "Content-Type": "audio/mpeg" });
      res.end(fakeAudio);
    },
    async () => {
      const res = await fetch(`${base}/api/v1/speak`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Привет, это тест озвучки" })
      });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), "audio/mpeg");
      const received = Buffer.from(await res.arrayBuffer());
      assert.equal(Buffer.compare(received, fakeAudio), 0);
    }
  );
});

test("POST /api/v1/speak with empty text returns 400", async () => {
  const res = await fetch(`${base}/api/v1/speak`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "   " })
  });
  assert.equal(res.status, 400);
});

test("POST /api/v1/speak with text over 1000 characters returns 400", async () => {
  const res = await fetch(`${base}/api/v1/speak`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "a".repeat(1001) })
  });
  assert.equal(res.status, 400);
});

// --- speechId (lazy TTS registry, GET /api/v1/speak/:id) --------------------

test("POST /api/v1/query with a plain question returns a speechId", async () => {
  const res = await fetch(`${base}/api/v1/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "Сколько будет дважды два?" })
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.kind, "ai");
  assert.ok(body.speechId, "expected a speechId in the response");
});

test("POST /api/v1/query with a note does not return a speechId", async () => {
  const res = await fetch(`${base}/api/v1/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "Запиши: без озвучки" })
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.kind, "note");
  assert.equal(body.speechId, undefined);
});

test("POST /api/v1/query with a home command does not return a speechId", async () => {
  const res = await fetch(`${base}/api/v1/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "включи свет в кухне" })
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.kind, "home");
  assert.equal(body.speechId, undefined);
});

test("POST /api/v1/voice in demo mode returns a speechId for kind ai", async () => {
  const res = await fetch(`${base}/api/v1/voice`, {
    method: "POST",
    headers: { "Content-Type": "audio/opus" },
    body: Buffer.from([1, 2, 3, 4, 5])
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.kind, "ai");
  assert.ok(body.speechId, "expected a speechId in the response");
});

test("GET /api/v1/speak/:id with an unknown id returns 404 not_found", async (t) => {
  t.after(() => resetSpeechRegistry());
  const res = await fetch(`${base}/api/v1/speak/does-not-exist`);
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "not_found");
});

test("GET /api/v1/speak/:id without a configured TTS provider returns 503", async (t) => {
  t.after(() => resetSpeechRegistry());
  const queryRes = await fetch(`${base}/api/v1/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "Ещё один вопрос без настроенного TTS" })
  });
  const { speechId } = await queryRes.json();
  assert.ok(speechId);

  const res = await fetch(`${base}/api/v1/speak/${speechId}`);
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.ok, false);
});

test("GET /api/v1/speak/:id with a mock TTS provider streams the exact registered text as audio/mpeg", async (t) => {
  t.after(() => resetSpeechRegistry());
  const fakeAudio = Buffer.from([0xff, 0xfb, 0x90, 0x00, 9, 9, 9]);
  let receivedBody = null;
  let callCount = 0;

  // Register the speechId first, in plain demo mode (config.provider stays
  // "mock" here) — this is the deterministic demo AI reply text that
  // /api/v1/speak/:id must later synthesize. Doing this OUTSIDE
  // withMockOpenAI matters: that helper flips config.provider away from
  // "mock", which would otherwise also redirect this /api/v1/query call
  // itself to the fake TTS server instead of the demo chat path.
  const queryRes = await fetch(`${base}/api/v1/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "Проверка точного текста озвучки" })
  });
  const queryBody = await queryRes.json();
  assert.equal(queryBody.kind, "ai");
  assert.ok(queryBody.speechId);

  // Laziness: registering a speechId must NOT call the TTS provider — only
  // requesting the audio does. No mock server is even listening yet.
  assert.equal(callCount, 0, "TTS provider was called before the audio was requested");

  await withMockOpenAI(
    (req, res) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        callCount += 1;
        receivedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        res.writeHead(200, { "Content-Type": "audio/mpeg" });
        res.end(fakeAudio);
      });
    },
    async () => {
      const res = await fetch(`${base}/api/v1/speak/${queryBody.speechId}`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), "audio/mpeg");
      const received = Buffer.from(await res.arrayBuffer());
      assert.equal(Buffer.compare(received, fakeAudio), 0);

      assert.equal(callCount, 1, "expected exactly one TTS provider call");
      assert.equal(receivedBody.input, queryBody.text, "TTS provider did not receive the exact answer text");
    }
  );
});

test("GET /api/v1/speak/:id returns 404 once the entry expires (SPEECH_TTL_MS)", async (t) => {
  t.after(() => resetSpeechRegistry());
  const originalTtl = config.speechTtlMs;
  config.speechTtlMs = 1;
  t.after(() => { config.speechTtlMs = originalTtl; });

  const queryRes = await fetch(`${base}/api/v1/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "Проверка протухания идентификатора" })
  });
  const { speechId } = await queryRes.json();
  assert.ok(speechId);

  await new Promise((resolve) => setTimeout(resolve, 20));

  const res = await fetch(`${base}/api/v1/speak/${speechId}`);
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.error.code, "not_found");
});

test("GET /api/v1/speak/:id without a device token is rejected once a token is configured", async (t) => {
  t.after(() => resetSpeechRegistry());
  const queryRes = await fetch(`${base}/api/v1/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "Проверка авторизации на озвучке" })
  });
  const { speechId } = await queryRes.json();
  assert.ok(speechId);

  const original = config.token;
  config.token = "s3cr3t-device-token";
  t.after(() => { config.token = original; });

  const noHeader = await fetch(`${base}/api/v1/speak/${speechId}`);
  assert.equal(noHeader.status, 401);

  const withHeader = await fetch(`${base}/api/v1/speak/${speechId}`, {
    headers: { "X-TimeW-Device-Token": "s3cr3t-device-token" }
  });
  // Still 503 here (no TTS provider configured in the base test suite) —
  // the point of this test is only that auth is enforced before that check.
  assert.equal(withHeader.status, 503);
});

// --- Озвучка через Gemini ------------------------------------------------
//
// Смысл этих проверок: озвучка должна работать тем же ключом, что и ответы,
// а сырые сэмплы от Gemini — превращаться в файл, который часы смогут
// проиграть. Без контейнера WAV звук не воспроизводится нигде.

test("озвучка через Gemini идёт тем же ключом и возвращает WAV", async (t) => {
  let requestedPath = null;
  let sentBody = null;
  // 2400 сэмплов тишины — достаточно, чтобы проверить заголовок и длину.
  const pcm = Buffer.alloc(4800);
  await withMockGemini(
    (req, res) => {
      requestedPath = req.url;
      let raw = "";
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        sentBody = JSON.parse(raw);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/L16;codec=pcm;rate=24000", data: pcm.toString("base64") } }] } }]
        }));
      });
    },
    async () => {
      const originalProvider = config.ttsProvider;
      config.ttsProvider = "gemini";
      t.after(() => { config.ttsProvider = originalProvider; });

      const res = await fetch(`${base}/api/v1/speak`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Привет" })
      });

      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), "audio/wav");
      const audio = Buffer.from(await res.arrayBuffer());
      assert.equal(audio.subarray(0, 4).toString(), "RIFF", "без заголовка WAV часы не проиграют звук");
      assert.equal(audio.subarray(8, 12).toString(), "WAVE");
      assert.equal(audio.length, 44 + pcm.length);
      assert.equal(audio.readUInt32LE(24), 24000, "частота берётся из ответа провайдера");
      assert.ok(requestedPath.includes(":generateContent"), requestedPath);
      assert.deepEqual(sentBody.generationConfig.responseModalities, ["AUDIO"]);
      assert.ok(sentBody.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName);
    }
  );
});

test("частота берётся из ответа, а не зашита: иначе звук пойдёт не на той скорости", async (t) => {
  await withMockGemini(
    (req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/L16;codec=pcm;rate=16000", data: Buffer.alloc(320).toString("base64") } }] } }]
      }));
    },
    async () => {
      const originalProvider = config.ttsProvider;
      config.ttsProvider = "gemini";
      t.after(() => { config.ttsProvider = originalProvider; });

      const res = await fetch(`${base}/api/v1/speak`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "тест" })
      });
      const audio = Buffer.from(await res.arrayBuffer());
      assert.equal(audio.readUInt32LE(24), 16000);
      assert.equal(audio.readUInt32LE(28), 16000 * 2, "byteRate должен пересчитаться вместе с частотой");
    }
  );
});

test("ответ Gemini без аудио даёт 502, а не пустой файл", async (t) => {
  await withMockGemini(
    (req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: "я не умею" }] } }] }));
    },
    async () => {
      const originalProvider = config.ttsProvider;
      config.ttsProvider = "gemini";
      t.after(() => { config.ttsProvider = originalProvider; });

      const res = await fetch(`${base}/api/v1/speak`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "тест" })
      });
      assert.equal(res.status, 502);
      const body = await res.json();
      assert.equal(body.ok, false);
    }
  );
});

test("статус сообщает, что озвучка доступна, когда включён Gemini", async (t) => {
  const original = { provider: config.ttsProvider, key: config.apiKey };
  config.ttsProvider = "gemini";
  config.apiKey = "test-key";
  t.after(() => { config.ttsProvider = original.provider; config.apiKey = original.key; });

  const body = await (await fetch(`${base}/api/v1/status`)).json();
  assert.equal(body.capabilities.speech, true, "иначе часы напишут, что озвучка не настроена");
});

// --- Определение формата записи ------------------------------------------
//
// Часы присылали application/octet-stream, и Gemini отклонял запрос с
// «invalid argument» — запись при этом была нормальной. Поэтому формат
// определяется по байтам, а не по заявленному типу.

test("Ogg-запись распознаётся, даже если часы заявили octet-stream", async () => {
  const ogg = Buffer.concat([Buffer.from("OggS"), Buffer.alloc(60)]);
  let sentMime = null;
  await withMockGemini(
    (req, res) => {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        const body = JSON.parse(raw);
        const part = body.contents[0].parts.find((p) => p.inlineData);
        sentMime = part.inlineData.mimeType;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ transcript: "привет", answer: "привет" }) }] } }] }));
      });
    },
    async () => {
      const original = config.provider;
      config.provider = "gemini";
      try {
        const res = await fetch(`${base}/api/v1/voice`, {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: ogg
        });
        assert.equal(res.status, 200);
        assert.equal(sentMime, "audio/ogg", "иначе провайдер отклонит запись как неизвестную");
      } finally { config.provider = original; }
    }
  );
});

test("WAV распознаётся по заголовку", async () => {
  const wav = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVEfmt "), Buffer.alloc(40)]);
  let sentMime = null;
  await withMockGemini(
    (req, res) => {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        sentMime = JSON.parse(raw).contents[0].parts.find((p) => p.inlineData).inlineData.mimeType;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ transcript: "тест", answer: "тест" }) }] } }] }));
      });
    },
    async () => {
      const original = config.provider;
      config.provider = "gemini";
      try {
        await fetch(`${base}/api/v1/voice`, { method: "POST", headers: { "Content-Type": "audio/wav" }, body: wav });
        assert.equal(sentMime, "audio/wav");
      } finally { config.provider = original; }
    }
  );
});

test("неизвестный формат даёт понятный отказ, а не «invalid argument» от провайдера", async () => {
  const garbage = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c]);
  await withMockGemini(
    (req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end("{}"); },
    async () => {
      const original = config.provider;
      config.provider = "gemini";
      try {
        const res = await fetch(`${base}/api/v1/voice`, {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: garbage
        });
        assert.equal(res.status, 415);
        const body = await res.json();
        assert.equal(body.error.code, "unsupported_audio");
      } finally { config.provider = original; }
    }
  );
});

test("AMR отклоняется с объяснением: Gemini его не принимает", async () => {
  const amr = Buffer.concat([Buffer.from("#!AMR\n"), Buffer.alloc(30)]);
  await withMockGemini(
    (req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end("{}"); },
    async () => {
      const original = config.provider;
      config.provider = "gemini";
      try {
        const res = await fetch(`${base}/api/v1/voice`, { method: "POST", headers: { "Content-Type": "audio/amr" }, body: amr });
        assert.equal(res.status, 415);
        const body = await res.json();
        assert.match(body.error.message, /AMR/);
      } finally { config.provider = original; }
    }
  );
});

test("запись принимается текстом в JSON: рантайм часов не отправляет двоичное тело", async () => {
  const ogg = Buffer.concat([Buffer.from("OggS"), Buffer.alloc(80)]);
  let sentMime = null;
  await withMockGemini(
    (req, res) => {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        sentMime = JSON.parse(raw).contents[0].parts.find((p) => p.inlineData).inlineData.mimeType;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ transcript: "привет", answer: "привет" }) }] } }] }));
      });
    },
    async () => {
      const original = config.provider;
      config.provider = "gemini";
      try {
        const res = await fetch(`${base}/api/v1/voice`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ audioBase64: ogg.toString("base64"), contentType: "audio/opus" })
        });
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.transcript, "привет");
        assert.equal(sentMime, "audio/ogg", "формат по-прежнему определяется по байтам, а не по заявленному типу");
      } finally { config.provider = original; }
    }
  );
});

test("пустая запись в JSON отклоняется", async () => {
  const res = await fetch(`${base}/api/v1/voice`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ audioBase64: "", contentType: "audio/opus" })
  });
  assert.equal(res.status, 400);
});

test("внутренняя ошибка провайдера повторяется один раз", async () => {
  // По логам с устройства половина голосовых запросов получала от Gemini
  // «HTTP 500: Internal error» — его собственный сбой, не связанный с
  // записью. Повтор делает это незаметным для человека.
  let attempts = 0;
  const ogg = Buffer.concat([Buffer.from("OggS"), Buffer.alloc(80)]);
  await withMockGemini(
    (req, res) => {
      attempts += 1;
      req.resume();
      req.on("end", () => {
        if (attempts === 1) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "Internal error encountered." } }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ transcript: "привет", answer: "здравствуйте" }) }] } }] }));
      });
    },
    async () => {
      const original = config.provider;
      config.provider = "gemini";
      try {
        const res = await fetch(`${base}/api/v1/voice`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ audioBase64: ogg.toString("base64"), contentType: "audio/opus" })
        });
        assert.equal(res.status, 200, "после повтора запрос обязан пройти");
        assert.equal(attempts, 2, "ровно одна повторная попытка, не больше");
      } finally { config.provider = original; }
    }
  );
});

test("отказ провайдера по существу не повторяется", async () => {
  // На 400 повтор бессмыслен: тот же запрос не понравится и во второй раз.
  let attempts = 0;
  const ogg = Buffer.concat([Buffer.from("OggS"), Buffer.alloc(80)]);
  await withMockGemini(
    (req, res) => {
      attempts += 1;
      req.resume();
      req.on("end", () => {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Invalid argument" } }));
      });
    },
    async () => {
      const original = config.provider;
      config.provider = "gemini";
      try {
        await fetch(`${base}/api/v1/voice`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ audioBase64: ogg.toString("base64"), contentType: "audio/opus" })
        });
        assert.equal(attempts, 1);
      } finally { config.provider = original; }
    }
  );
});
