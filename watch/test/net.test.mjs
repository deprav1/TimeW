// Сценарии определения сети. Различать «на часах нет сети» и «шлюз молчит»
// важно: иначе человек идёт править адрес шлюза, когда достаточно включить
// Wi-Fi. А тип подключения решает главный архитектурный вопрос проекта
// (docs/architecture.md).
import test from "node:test";
import assert from "node:assert/strict";
import { network, resetAll } from "../testkit/system.mjs";

const { isOnline, networkType } = await import("../src/common/net.js");

test("Wi-Fi считается сетью", async () => {
  resetAll();
  network.type = "wifi";
  assert.equal(await new Promise(isOnline), true);
});

test("подключение через телефон считается сетью", async () => {
  resetAll();
  network.type = "bluetooth";
  assert.equal(await new Promise(isOnline), true, "часы без eSIM живут именно этим путём");
});

test("отсутствие сети распознаётся", async () => {
  resetAll();
  network.type = "none";
  assert.equal(await new Promise(isOnline), false);
});

test("при неясности приложение пробует запрос, а не отказывает заранее", async () => {
  resetAll();
  network.type = null;
  assert.equal(await new Promise(isOnline), true, "лучше внятная ошибка шлюза, чем молчаливый отказ");
});

test("молчащий модуль сети не вешает экран", async () => {
  resetAll();
  network.silent = true;
  assert.equal(await new Promise(isOnline), true);
});

test("тип подключения виден как есть — это и есть проверка архитектуры", async () => {
  resetAll();
  network.type = "bluetooth";
  assert.equal(await new Promise(networkType), "bluetooth");
});

test("неизвестный тип не выдаётся за рабочий", async () => {
  resetAll();
  network.silent = true;
  assert.equal(await new Promise(networkType), "");
});
