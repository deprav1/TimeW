// Сценарии общения со шлюзом: что именно уходит в сеть и как приложение
// ведёт себя, когда шлюз отвечает ошибкой, отвечает мусором или молчит.
import test from "node:test";
import assert from "node:assert/strict";
import { fetchModule, file, storage, resetAll } from "../testkit/system.mjs";

const { loadSettings } = await import("../src/common/settings.js");
const { query, voiceUri, listNotes, deleteNote, confirmHome } = await import("../src/common/api.js");

const GATEWAY = "http://gateway.test:8787";
const TOKEN = "тестовый-токен";

async function ready() {
  resetAll();
  storage.data.gatewayUrl = GATEWAY;
  storage.data.deviceToken = TOKEN;
  const { CONFIG_STAMP } = await import("../src/common/config.js");
  storage.data.configStamp = CONFIG_STAMP;
  await new Promise((resolve) => loadSettings(resolve));
  fetchModule.reset();
}

function ok(body) {
  return { response: { code: 200, data: JSON.stringify({ ok: true, ...body }) } };
}

function lastCall() {
  return fetchModule.calls[fetchModule.calls.length - 1];
}

test("текстовый запрос уходит с токеном и ключом идемпотентности", async () => {
  await ready();
  fetchModule.scripted.push(ok({ kind: "ai", text: "ответ" }));
  const body = await new Promise((done, fail) => query("сколько лететь до Лиссабона", done, fail));

  assert.equal(body.text, "ответ");
  const call = lastCall();
  assert.equal(call.url, `${GATEWAY}/api/v1/query`);
  assert.equal(call.header["X-TimeW-Device-Token"], TOKEN);
  assert.ok(call.header["Idempotency-Key"], "без него обрыв связи создаст дубль заметки");
  assert.equal(JSON.parse(call.data).requestId, call.header["Idempotency-Key"]);
});

test("повторная отправка той же заметки идёт с тем же ключом", async () => {
  await ready();
  fetchModule.scripted.push(ok({ kind: "note" }), ok({ kind: "note" }));
  await new Promise((done, fail) => query("Запиши: фильтр", done, fail, "ключ-1"));
  await new Promise((done, fail) => query("Запиши: фильтр", done, fail, "ключ-1"));
  assert.equal(fetchModule.calls[0].header["Idempotency-Key"], "ключ-1");
  assert.equal(fetchModule.calls[1].header["Idempotency-Key"], "ключ-1");
});

test("надиктованная заметка сначала показывается на подтверждение", async () => {
  await ready();
  file.files["internal://cache/a.opus"] = new ArrayBuffer(64);
  fetchModule.scripted.push(ok({ kind: "draft", transcript: "купить фильтр" }));
  await new Promise((done, fail) => voiceUri("internal://cache/a.opus", "audio/opus", "note", done, fail));

  const url = lastCall().url;
  assert.ok(url.includes("intent=note"), url);
  assert.ok(url.includes("preview=1"), "без preview заметка сохранится до того, как человек её увидит");
});

test("отложенная заметка досылается без подтверждения", async () => {
  await ready();
  file.files["internal://cache/a.opus"] = new ArrayBuffer(64);
  fetchModule.scripted.push(ok({ kind: "note" }));
  await new Promise((done, fail) => {
    voiceUri("internal://cache/a.opus", "audio/opus", "note", done, fail, { preview: false, requestKey: "ключ-2" });
  });

  const call = lastCall();
  assert.ok(call.url.includes("intent=note"));
  assert.ok(!call.url.includes("preview"), "подтверждать некому: досылка идёт фоном");
  assert.equal(call.header["Idempotency-Key"], "ключ-2");
});

test("вопрос голосом идёт без intent — тип определяет шлюз", async () => {
  await ready();
  file.files["internal://cache/a.opus"] = new ArrayBuffer(64);
  fetchModule.scripted.push(ok({ kind: "ai", text: "ответ", transcript: "вопрос" }));
  await new Promise((done, fail) => voiceUri("internal://cache/a.opus", "audio/opus", "", done, fail));
  assert.ok(!lastCall().url.includes("intent="), lastCall().url);
});

test("пропавшая запись отличается от обрыва связи", async () => {
  await ready();
  // Файла в хранилище нет — рантайм убрал его из кэша приложения.
  const error = await new Promise((resolve) => {
    voiceUri("internal://cache/gone.opus", "audio/opus", "note", () => resolve(null), resolve);
  });
  assert.ok(error, "ожидалась ошибка");
  assert.equal(error.gone, true, "иначе элемент навсегда застрянет в очереди на досылку");
});

test("обрыв после отправки сохраняет исходный ключ идемпотентности", async () => {
  await ready();
  file.files["internal://cache/a.opus"] = new ArrayBuffer(64);
  fetchModule.scripted.push({ error: { message: "connection lost" } });
  const error = await new Promise((resolve) => {
    voiceUri("internal://cache/a.opus", "audio/opus", "note", () => resolve(null), resolve);
  });
  assert.ok(error?.requestKey, "иначе досылка после потерянного ответа создаст дубль");
  assert.equal(lastCall().header["Idempotency-Key"], error.requestKey);
});

test("пустая запись не уходит в сеть", async () => {
  await ready();
  file.files["internal://cache/empty.opus"] = new ArrayBuffer(0);
  const error = await new Promise((resolve) => {
    voiceUri("internal://cache/empty.opus", "audio/opus", "note", () => resolve(null), resolve);
  });
  assert.match(error.message, /Ничего не записалось/);
  assert.equal(fetchModule.calls.length, 0, "мегабайт тишины гонять на шлюз незачем");
});

test("неверный токен объясняется человеческим языком", async () => {
  await ready();
  fetchModule.scripted.push({ response: { code: 401, data: JSON.stringify({ ok: false }) } });
  const error = await new Promise((resolve) => query("привет", () => resolve(null), resolve));
  assert.match(error.message, /токен/i);
});

test("перегруженный шлюз не выглядит поломкой приложения", async () => {
  await ready();
  fetchModule.scripted.push({ response: { code: 429, data: JSON.stringify({ ok: false }) } });
  const error = await new Promise((resolve) => query("привет", () => resolve(null), resolve));
  assert.match(error.message, /много запросов/i);
});

test("мусор вместо JSON не роняет приложение", async () => {
  await ready();
  fetchModule.scripted.push({ response: { code: 200, data: "<html>шлюз за чужим порталом</html>" } });
  const error = await new Promise((resolve) => query("привет", () => resolve(null), resolve));
  assert.ok(error, "ожидалась внятная ошибка, а не исключение");
});

test("молчащий системный модуль не вешает приложение навсегда", async () => {
  await ready();
  fetchModule.scripted.push({ silent: true });
  const started = Date.now();
  const error = await new Promise((resolve) => query("привет", () => resolve(null), resolve));
  assert.ok(error, "сторожевой таймер обязан сработать");
  // Граница привязана к самой константе, а не к числу: таймауты растут вместе
  // с пониманием того, насколько медленным бывает канал через телефон, и
  // зашитое число превращало бы такое изменение в ложное падение.
  const { REQUEST_TIMEOUT_MS } = await import("../src/common/config.js");
  assert.ok(Date.now() - started < REQUEST_TIMEOUT_MS + 5000, "ожидание не должно быть бесконечным");
});

test("недоступный fetch не роняет экран", async () => {
  await ready();
  fetchModule.throwOnCall = true;
  const error = await new Promise((resolve) => query("привет", () => resolve(null), resolve));
  assert.ok(error);
});

test("список заметок и удаление ходят по своим адресам", async () => {
  await ready();
  fetchModule.scripted.push(ok({ notes: [] }));
  await new Promise((done, fail) => listNotes(done, fail));
  assert.equal(lastCall().url, `${GATEWAY}/api/v1/notes`);
  assert.equal(lastCall().method, "GET");

  fetchModule.scripted.push(ok({}));
  await new Promise((done, fail) => deleteNote("note-7", done, fail));
  assert.equal(lastCall().url, `${GATEWAY}/api/v1/notes/note-7`);
  assert.equal(lastCall().method, "DELETE");
});

test("домашняя команда выполняется отдельным подтверждением", async () => {
  await ready();
  fetchModule.scripted.push(ok({ executed: true }));
  await new Promise((done, fail) => confirmHome("одноразовый-токен", done, fail));
  assert.equal(lastCall().url, `${GATEWAY}/api/v1/home/confirm`);
  assert.equal(JSON.parse(lastCall().data).confirmationToken, "одноразовый-токен");
});

test("запись уходит текстом в JSON, а не двоичным телом", async () => {
  await ready();
  // Четыре байта «OggS» — проверяем и кодирование, и то, что тип сохранён.
  file.files["internal://cache/a.opus"] = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0x01, 0x02]).buffer;
  fetchModule.scripted.push(ok({ kind: "ai", text: "ответ", transcript: "вопрос" }));
  await new Promise((done, fail) => voiceUri("internal://cache/a.opus", "audio/opus", "", done, fail));

  const call = lastCall();
  assert.equal(call.header["Content-Type"], "application/json", "двоичное тело рантайм часов не отправляет");
  const body = JSON.parse(call.data);
  assert.equal(body.contentType, "audio/opus");
  assert.equal(body.audioBase64, "T2dnUwEC", "кодирование должно быть обычным base64");
});
