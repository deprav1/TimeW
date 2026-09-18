// Сценарии локального списка заметок: что человек видит, когда шлюз
// недоступен. На часах без eSIM это обычное состояние, а не авария.
import test from "node:test";
import assert from "node:assert/strict";
import { storage, resetAll } from "../testkit/system.mjs";

const { loadCachedNotes, getCachedNotes, saveCachedNotes } = await import("../src/common/notes-cache.js");

const NOTES = [
  { id: "1", text: "купить фильтр", createdAt: "2026-09-18T09:00:00.000Z" },
  { id: "2", text: "позвонить в сервис", createdAt: "2026-09-18T10:00:00.000Z" }
];

function load() {
  return new Promise((resolve) => loadCachedNotes(resolve));
}

test("на чистых часах кэша нет — это не пустой список", async () => {
  resetAll();
  const cached = await load();
  assert.equal(cached, null, "null значит «не знаем», а пустой массив значит «заметок нет»");
});

test("полученный от шлюза список переживает перезапуск", async () => {
  resetAll();
  await new Promise((done) => saveCachedNotes(NOTES, done));
  const cached = await load();
  assert.equal(cached.length, 2);
  assert.equal(cached[0].text, "купить фильтр");
});

test("кэш не растёт бесконечно", async () => {
  resetAll();
  const many = [];
  for (let i = 0; i < 40; i += 1) many.push({ id: String(i), text: `заметка ${i}`, createdAt: new Date().toISOString() });
  await new Promise((done) => saveCachedNotes(many, done));
  assert.equal((await load()).length, 20);
});

test("в кэш не утекают лишние поля", async () => {
  resetAll();
  await new Promise((done) => saveCachedNotes([{ id: "1", text: "заметка", createdAt: "x", secret: "не надо" }], done));
  assert.deepEqual(Object.keys((await load())[0]).sort(), ["createdAt", "id", "text"]);
});

test("битый кэш не роняет экран", async () => {
  resetAll();
  storage.data.cachedNotes = "{ это не список";
  assert.equal(await load(), null);
});

test("мусорные элементы отбрасываются, годные остаются", async () => {
  resetAll();
  storage.data.cachedNotes = JSON.stringify([{ id: "1", text: "годная" }, { text: "без id" }, null]);
  const cached = await load();
  assert.equal(cached.length, 1);
  assert.equal(cached[0].text, "годная");
});

test("отказ storage не мешает показать список", async () => {
  resetAll();
  storage.failOnSet = true;
  const ok = await new Promise((done) => saveCachedNotes(NOTES, done));
  assert.equal(ok, false);
  assert.equal(getCachedNotes().length, 2, "в памяти список остаётся, экран не должен пострадать");
});

test("сломанное чтение storage даёт «не знаем», а не падение", async () => {
  resetAll();
  storage.failOnGet = true;
  assert.equal(await load(), null);
});
