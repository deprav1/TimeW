// Дымовой тест запущенного шлюза: один прогон всех эндпоинтов.
//
//   npm run smoke                                # http://127.0.0.1:8787
//   npm run smoke -- https://my-gateway          # другой адрес
//   npm run smoke -- --audio                     # добавить проверку /transcribe
//
// Токен подставляется из server/.env сам; переопределить — TOKEN=... .
//
// В live-режиме прогон тратит запросы к AI-провайдеру: один вызов чата,
// и ещё один вызов распознавания, если передан --audio.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Токен лежит в server/.env — тот же файл, из которого его берёт шлюз.
// Заставлять человека копировать его в переменную окружения перед каждым
// прогоном значит превращать проверку в отдельную процедуру с опечатками.
function tokenFromEnvFile() {
  try {
    const text = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", ".env"), "utf8");
    const match = text.match(/^\s*DEVICE_TOKEN\s*=\s*(.*?)\s*$/m);
    return match ? match[1] : "";
  } catch {
    return "";
  }
}

const base = (process.argv.find((arg) => arg.startsWith("http")) || "http://127.0.0.1:8787").replace(/\/$/, "");
const token = process.env.TOKEN || process.env.DEVICE_TOKEN || tokenFromEnvFile();
const withAudio = process.argv.includes("--audio");

let passed = 0;
let failed = 0;
let skipped = 0;
// Заполняется первой же проверкой /health: в live-режиме часть проверок
// с заглушечным аудио неприменима (см. skipIfLiveRejectsFakeAudio).
let liveMode = false;

function headers(extra) {
  // Connection: close avoids a rare keep-alive socket reuse glitch (an
  // oversized-body request that intentionally aborts early can leave
  // unread bytes on a pooled connection, resetting the next request on the
  // same socket) — irrelevant for the gateway itself, just makes this
  // one-shot smoke client robust against it.
  return { Connection: "close", ...(token ? { "X-TimeW-Device-Token": token } : {}), ...extra };
}

async function call(method, path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: headers(options.headers),
    body: options.body
  });
  let body = null;
  try {
    body = await response.json();
  } catch {}
  return { status: response.status, body, response };
}

async function check(name, run) {
  try {
    const detail = await run();
    passed += 1;
    console.log(`  ok   ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (cause) {
    if (cause?.isSkip) {
      skipped += 1;
      console.log(`  skip ${name} — ${cause.message}`);
      return;
    }
    failed += 1;
    console.log(`  FAIL ${name} — ${cause.message}`);
  }
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

// Проверки с синтетическим аудио (несколько байт-заглушек) осмысленны только
// в demo-режиме. На живом провайдере такой «звук» закономерно отвергается, и
// без этой ветки исправно работающий шлюз отчитывался бы четырьмя FAIL —
// ложная тревога, из-за которой перестают смотреть на настоящие.
function skipIfLiveRejectsFakeAudio(status) {
  if (liveMode && status === 502) {
    const error = new Error("живой провайдер не принимает тестовые байты — проверяйте с --audio или в demo-режиме");
    error.isSkip = true;
    throw error;
  }
}

console.log(`TimeW smoke: ${base}${token ? " (с токеном)" : " (без токена)"}\n`);

let createdId = null;

await check("10 быстрых GET /health подряд не упираются в rate limit", async () => {
  const results = await Promise.all(Array.from({ length: 10 }, () => call("GET", "/health")));
  const bad = results.find((r) => r.status !== 200);
  expect(!bad, `запрос вернул ${bad?.status} вместо 200 — лимит слишком строгий для обычной нагрузки`);
});

await check("GET /health", async () => {
  const { status, body } = await call("GET", "/health");
  expect(status === 200, `ожидался 200, получен ${status}`);
  expect(body?.ok === true, "ok !== true");
  expect(body.service === "timew-gateway", `service = ${body.service}`);
  liveMode = body.mode === "live";
  return `режим ${body.mode}, версия ${body.version}`;
});

await check("POST /api/v1/query — заметка", async () => {
  const marker = `smoke ${new Date().toISOString()}`;
  const { status, body } = await call("POST", "/api/v1/query", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: `Запиши: ${marker}` })
  });
  expect(status === 200, `ожидался 200, получен ${status}`);
  expect(body?.kind === "note", `kind = ${body?.kind}`);
  expect(body.note?.id, "в ответе нет note.id");
  createdId = body.note.id;
  return body.text;
});

await check("GET /api/v1/notes?limit=1 — заметка сохранилась", async () => {
  const { status, body } = await call("GET", "/api/v1/notes?limit=1");
  expect(status === 200, `ожидался 200, получен ${status}`);
  expect(Array.isArray(body?.notes), "notes не массив");
  expect(body.notes.length === 1, `вернулось ${body.notes.length} заметок вместо 1`);
  expect(body.notes[0].id === createdId, "первой заметкой оказалась не только что созданная");
  return body.notes[0].text;
});

await check("GET /api/v1/notes?limit=0 — невалидный лимит", async () => {
  const { status, body } = await call("GET", "/api/v1/notes?limit=0");
  expect(status === 400, `ожидался 400, получен ${status}`);
  expect(body?.ok === false, "ok !== false");
  return body.error?.message;
});

await check("POST /api/v1/query — домашняя команда только распознаётся", async () => {
  const { status, body } = await call("POST", "/api/v1/query", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "выключи свет в спальне" })
  });
  expect(status === 200, `ожидался 200, получен ${status}`);
  expect(body?.kind === "home", `kind = ${body?.kind}`);
  expect(body.requiresConfirmation === true, "requiresConfirmation !== true");
  return `${body.command.action} ${body.command.device} / ${body.command.room}`;
});

await check("GET /api/v1/home/devices", async () => {
  // Не форсируем состояние Tuya-интеграции: если в .env шлюза она не
  // настроена — ожидаем понятный 503; если настроена — просто проверяем,
  // что ответ 200 со списком устройств (без похода в реальное облако Tuya
  // из самого smoke-теста, это делает уже сам шлюз).
  const { status, body } = await call("GET", "/api/v1/home/devices");
  expect(status === 503 || status === 200, `ожидался 503 или 200, получен ${status}`);
  if (status === 503) {
    expect(body?.error?.code === "tuya_disabled", `code = ${body?.error?.code}`);
    return "Tuya не настроена (ожидаемо)";
  }
  expect(Array.isArray(body?.devices), "devices не массив");
  return `устройств: ${body.devices.length}`;
});

await check("POST /api/v1/query — AI-ответ", async () => {
  const { status, body } = await call("POST", "/api/v1/query", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "Скажи одно слово: готово" })
  });
  expect(status === 200, `ожидался 200, получен ${status}`);
  expect(body?.kind === "ai", `kind = ${body?.kind}`);
  expect(body.text, "пустой text в ответе");
  return `[${body.source}] ${body.text.slice(0, 60)}`;
});

await check("POST /api/v1/query — пустой text", async () => {
  const { status } = await call("POST", "/api/v1/query", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "   " })
  });
  expect(status === 400, `ожидался 400, получен ${status}`);
});

await check("DELETE /api/v1/notes/:id", async () => {
  expect(createdId, "нечего удалять: заметка не создалась");
  const first = await call("DELETE", `/api/v1/notes/${createdId}`);
  expect(first.status === 200, `ожидался 200, получен ${first.status}`);
  expect(first.body?.deleted === true, "deleted !== true");
  const second = await call("DELETE", `/api/v1/notes/${createdId}`);
  expect(second.status === 404, `повторное удаление: ожидался 404, получен ${second.status}`);
  expect(second.body?.error?.code === "not_found", `code = ${second.body?.error?.code}`);
  return "удалена, повторный DELETE даёт 404";
});

await check("OPTIONS — preflight", async () => {
  const { status, response } = await call("OPTIONS", "/api/v1/query");
  expect(status === 204, `ожидался 204, получен ${status}`);
  const allowed = response.headers.get("access-control-allow-headers") || "";
  expect(/x-timew-device-token/i.test(allowed), `в Allow-Headers нет токена: ${allowed}`);
  return allowed;
});

await check("GET /нет-такого — 404", async () => {
  const { status, body } = await call("GET", "/no-such-endpoint");
  expect(status === 404, `ожидался 404, получен ${status}`);
  expect(body?.error?.code === "not_found", `code = ${body?.error?.code}`);
});

if (token) {
  await check("запрос без токена отклоняется", async () => {
    const response = await fetch(`${base}/api/v1/notes`);
    expect(response.status === 401, `ожидался 401, получен ${response.status}`);
    const body = await response.json();
    expect(body?.error?.code === "unauthorized", `code = ${body?.error?.code}`);
  });
} else {
  console.log("  skip проверка 401 — TOKEN не задан");
}

await check("POST /api/v1/transcribe — пустое тело", async () => {
  const { status } = await call("POST", "/api/v1/transcribe", {
    headers: { "Content-Type": "audio/opus" },
    body: Buffer.alloc(0)
  });
  expect(status === 400, `ожидался 400, получен ${status}`);
});

await check("POST /api/v1/transcribe — слишком большое тело", async () => {
  const { status } = await call("POST", "/api/v1/transcribe", {
    headers: { "Content-Type": "audio/opus" },
    body: Buffer.alloc(2 * 1024 * 1024)
  });
  expect(status === 413, `ожидался 413, получен ${status}`);
});

await check("POST /api/v1/transcribe — multipart/form-data (uri-upload path)", async () => {
  const boundary = "TimeWSmokeBoundary";
  const parts = [
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="clip.opus"\r\nContent-Type: audio/opus\r\n\r\n`, "utf8"),
    Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]),
    Buffer.from(`\r\n--${boundary}--\r\n`, "utf8")
  ];
  const { status, body } = await call("POST", "/api/v1/transcribe", {
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body: Buffer.concat(parts)
  });
  skipIfLiveRejectsFakeAudio(status);
  expect(status === 200, `ожидался 200, получен ${status}`);
  expect(body?.ok === true, "ok !== true");
  return `[${body.source}] ${String(body.text).slice(0, 60)}`;
});

if (withAudio) {
  await check("POST /api/v1/transcribe — короткое аудио", async () => {
    const { status, body } = await call("POST", "/api/v1/transcribe", {
      headers: { "Content-Type": "audio/wav" },
      body: Buffer.alloc(4096)
    });
    expect(status === 200, `ожидался 200, получен ${status}`);
    return `[${body.source}] ${String(body.text).slice(0, 60)}`;
  });
} else {
  console.log("  skip реальное распознавание — запустите с --audio");
}

await check("POST /api/v1/voice — сырое аудио (demo-режим → transcript + text)", async () => {
  const { status, body } = await call("POST", "/api/v1/voice", {
    headers: { "Content-Type": "audio/opus" },
    body: Buffer.from([1, 2, 3, 4, 5])
  });
  skipIfLiveRejectsFakeAudio(status);
  expect(status === 200, `ожидался 200, получен ${status}`);
  expect(body?.ok === true, "ok !== true");
  expect(body.transcript, "в ответе нет transcript");
  expect(body.text, "в ответе нет text");
  return `[${body.kind}/${body.source}] ${String(body.text).slice(0, 60)}`;
});

await check("POST /api/v1/dialog/reset", async () => {
  const { status, body } = await call("POST", "/api/v1/dialog/reset");
  expect(status === 200, `ожидался 200, получен ${status}`);
  expect(body?.ok === true, "ok !== true");
  return `очищено реплик: ${body.cleared}`;
});

await check("POST /api/v1/speak — адаптивная проверка (503 в demo или 200 с аудио — оба ок)", async () => {
  const { status, response } = await call("POST", "/api/v1/speak", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "Проверка озвучки" })
  });
  expect(status === 503 || status === 200, `ожидался 503 или 200, получен ${status}`);
  if (status === 503) return "TTS не настроен (ожидаемо в demo-режиме)";
  const contentType = response.headers.get("content-type") || "";
  expect(contentType.startsWith("audio/"), `content-type = ${contentType}`);
  return `аудио получено (${contentType})`;
});

let voiceSpeechId = null;
await check("POST /api/v1/voice — ответ содержит speechId", async () => {
  const { status, body } = await call("POST", "/api/v1/voice", {
    headers: { "Content-Type": "audio/opus" },
    body: Buffer.from([1, 2, 3, 4, 5])
  });
  skipIfLiveRejectsFakeAudio(status);
  expect(status === 200, `ожидался 200, получен ${status}`);
  expect(body?.kind === "ai", `kind = ${body?.kind}`);
  expect(body?.speechId, "в ответе нет speechId");
  voiceSpeechId = body.speechId;
  return voiceSpeechId;
});

await check("GET /api/v1/speak/:id — адаптивная проверка (503 в demo или 200 с аудио — оба ок)", async () => {
  if (!voiceSpeechId && liveMode) skipIfLiveRejectsFakeAudio(502);
  expect(voiceSpeechId, "нечего запрашивать: speechId не получен на предыдущем шаге");
  const { status, response } = await call("GET", `/api/v1/speak/${voiceSpeechId}`);
  expect(status === 503 || status === 200, `ожидался 503 или 200, получен ${status}`);
  if (status === 503) return "TTS не настроен (ожидаемо в demo-режиме)";
  const contentType = response.headers.get("content-type") || "";
  expect(contentType.startsWith("audio/"), `content-type = ${contentType}`);
  return `аудио получено (${contentType})`;
});

console.log(`\nИтог: ${passed} ok, ${failed} fail${skipped ? `, ${skipped} skip` : ""}`);
process.exit(failed ? 1 : 0);
