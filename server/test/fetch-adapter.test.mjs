// Проверка переходника на «веб»-модель HTTP — ту, в которой работают
// бесплатные хосты. Через него прогоняется настоящий обработчик шлюза, а
// Request и Response здесь тоже настоящие: в Node они стандартные. Поэтому
// тест доказывает не сам переходник в вакууме, а что шлюз в этой модели
// отвечает так же, как в обычной.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = await mkdtemp(join(tmpdir(), "timew-fetch-"));
process.env.DATA_DIR = dataDir;
process.env.MAX_AUDIO_BYTES = "1024";
process.env.AI_PROVIDER = "mock";
process.env.AI_API_KEY = "";
process.env.RATE_LIMIT_MAX = "1000000";
process.env.LOG_REQUESTS = "0";
delete process.env.DEVICE_TOKEN;

const { route, config } = await import("../src/server.mjs");
const { createFetchHandler } = await import("../src/fetch-adapter.mjs");

config.token = "";
config.tuyaAccessId = "";
config.tuyaAccessSecret = "";

const handler = createFetchHandler(route);
const url = (path) => `https://gateway.test${path}`;

after(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

test("GET /health отвечает так же, как в обычном режиме", async () => {
  const response = await handler(new Request(url("/health")));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.service, "timew-gateway");
});

test("тело запроса доходит до обработчика", async () => {
  const response = await handler(new Request(url("/api/v1/query"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "Запиши: проверка переходника" })
  }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.kind, "note");
  assert.equal(body.note.text, "проверка переходника");
});

test("сохранённая заметка видна следующим запросом", async () => {
  const response = await handler(new Request(url("/api/v1/notes")));
  const body = await response.json();
  assert.ok(body.notes.some((note) => note.text === "проверка переходника"));
});

test("query-строка не теряется по дороге", async () => {
  const response = await handler(new Request(url("/api/v1/notes?limit=1")));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(body.notes.length <= 1);
});

test("двоичное тело доходит целиком", async () => {
  const audio = new Uint8Array([1, 2, 3, 4, 5]);
  const response = await handler(new Request(url("/api/v1/voice"), {
    method: "POST",
    headers: { "Content-Type": "audio/opus" },
    body: audio
  }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.ok(body.transcript);
});

test("ключ идемпотентности работает и в этой модели", async () => {
  const make = () => new Request(url("/api/v1/query"), {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": "adapter-once" },
    body: JSON.stringify({ text: "Запиши: единожды" })
  });
  const first = await (await handler(make())).json();
  const second = await (await handler(make())).json();
  assert.equal(first.note.id, second.note.id, "повтор обязан вернуть ту же заметку, а не создать вторую");
});

test("OPTIONS отвечает 204 без тела", async () => {
  const response = await handler(new Request(url("/api/v1/query"), { method: "OPTIONS" }));
  assert.equal(response.status, 204);
  assert.equal(await response.text(), "");
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
});

test("неизвестный путь даёт 404 с кодом, а не пустой ответ", async () => {
  const response = await handler(new Request(url("/nope")));
  assert.equal(response.status, 404);
  const body = await response.json();
  assert.equal(body.error.code, "not_found");
});

test("битый JSON даёт 400, а не падение переходника", async () => {
  const response = await handler(new Request(url("/api/v1/query"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{это не json"
  }));
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.ok, false);
});

test("токен устройства проверяется так же", async () => {
  const original = config.token;
  config.token = "adapter-secret";
  try {
    const denied = await handler(new Request(url("/api/v1/notes")));
    assert.equal(denied.status, 401);
    const allowed = await handler(new Request(url("/api/v1/notes"), {
      headers: { "X-TimeW-Device-Token": "adapter-secret" }
    }));
    assert.equal(allowed.status, 200);
  } finally {
    config.token = original;
  }
});

test("превышение размера тела даёт 413", async () => {
  const response = await handler(new Request(url("/api/v1/transcribe"), {
    method: "POST",
    headers: { "Content-Type": "audio/opus" },
    body: new Uint8Array(4096)
  }));
  assert.equal(response.status, 413);
});
