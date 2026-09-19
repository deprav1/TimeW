// Сценарии настроек: что приложение знает о шлюзе после установки,
// переустановки и смены адреса.
import test from "node:test";
import assert from "node:assert/strict";
import { storage, resetAll } from "../testkit/system.mjs";

const { loadSettings, saveSettings, getCached, rememberTransferMode, applyRemoteRuntime, getRecordingSettings } = await import("../src/common/settings.js");
const { GATEWAY_URL, DEVICE_TOKEN, CONFIG_STAMP } = await import("../src/common/config.js");

function load() {
  return new Promise((resolve) => loadSettings(resolve));
}

test("на чистых часах настройки берутся из сборки", async () => {
  resetAll();
  const settings = await load();
  assert.equal(settings.gatewayUrl, GATEWAY_URL);
  assert.equal(settings.deviceToken, DEVICE_TOKEN);
});

test("выбор человека переживает перезапуск", async () => {
  resetAll();
  await load();
  await new Promise((done, fail) => saveSettings({ speakAnswers: true, aiProvider: "gemini" }, done, fail));
  const settings = await load();
  assert.equal(settings.speakAnswers, true);
  assert.equal(settings.aiProvider, "gemini");
});

test("новая сборка перекрывает адрес и токен прошлой установки", async () => {
  resetAll();
  // Часы после предыдущей установки: адрес старый, метка сборки чужая.
  storage.data.gatewayUrl = "http://192.168.0.99:8787";
  storage.data.deviceToken = "старый-токен";
  storage.data.configStamp = "сборка-которой-больше-нет";
  storage.data.speakAnswers = "1";

  const settings = await load();

  assert.equal(settings.gatewayUrl, GATEWAY_URL, "иначе установка нового .rpk выглядит как «ничего не изменилось»");
  assert.equal(settings.deviceToken, DEVICE_TOKEN);
  assert.equal(settings.configStamp, CONFIG_STAMP);
  assert.equal(settings.speakAnswers, true, "личный выбор сборка трогать не должна");
});

test("та же сборка настройки не трогает", async () => {
  resetAll();
  storage.data.gatewayUrl = "http://192.168.0.99:8787";
  storage.data.configStamp = CONFIG_STAMP;

  const settings = await load();
  assert.equal(settings.gatewayUrl, "http://192.168.0.99:8787");
});

test("хвостовой слэш в адресе срезается: иначе все пути уезжают в двойной слэш", async () => {
  resetAll();
  storage.data.gatewayUrl = "http://gateway.example:8787/";
  storage.data.configStamp = CONFIG_STAMP;
  const settings = await load();
  assert.equal(settings.gatewayUrl, "http://gateway.example:8787");
});

test("сломанный storage не оставляет экран настроек пустым", async () => {
  resetAll();
  storage.failOnGet = true;
  const settings = await load();
  assert.equal(settings.gatewayUrl, GATEWAY_URL, "ожидались значения по умолчанию, а не зависание");
});

test("молчащий storage не оставляет загрузку настроек навсегда", async () => {
  resetAll();
  storage.silentGet = true;
  const started = Date.now();
  const settings = await new Promise((resolve) => loadSettings(resolve));
  assert.equal(settings.gatewayUrl, GATEWAY_URL);
  assert.ok(Date.now() - started < 20000);
});

test("сработавший способ доставки записи запоминается", async () => {
  resetAll();
  await load();
  rememberTransferMode("upload");
  assert.equal(getCached().transferMode, "upload");
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(storage.data.transferMode, "upload");
});

test("настройки записи обновляются со шлюза, ограничиваются и кэшируются", async () => {
  resetAll();
  await load();
  await new Promise((resolve) => applyRemoteRuntime({
    revision: "voice-42",
    maxRecordingMs: 12000,
    silenceThreshold: 500,
    silenceDurationMs: 850,
    speechGraceMs: 700,
    frameSize: 99999,
    requestTimeoutMs: 40000,
    uploadTimeoutMs: 70000,
    autoStop: true,
    ttsFormat: "mp3"
  }, resolve));
  const runtime = getRecordingSettings();
  assert.equal(runtime.maxRecordingMs, 12000);
  assert.equal(runtime.silenceDurationMs, 850);
  assert.equal(runtime.frameSize, 4096, "документация ограничивает frameSize значением 4096");
  assert.equal(runtime.autoStop, true);
  assert.equal(storage.data.runtimeRevision, "voice-42");
  const reloaded = await load();
  assert.equal(reloaded.runtimeConfig.maxRecordingMs, 12000);
});

test("переключение настройки не затирает runtime-конфиг и способ доставки", async () => {
  resetAll();
  await load();
  await new Promise((resolve) => applyRemoteRuntime({
    revision: "runtime-7",
    maxRecordingMs: 14000,
    ttsFormat: "mp3"
  }, resolve));
  rememberTransferMode("upload");

  await new Promise((done, fail) => saveSettings({ speakAnswers: true }, done, fail));
  const saved = await load();
  assert.equal(saved.runtimeRevision, "runtime-7");
  assert.equal(saved.runtimeConfig.maxRecordingMs, 14000);
  assert.equal(saved.runtimeConfig.ttsFormat, "mp3");
  assert.equal(saved.transferMode, "upload");
});
