import test from "node:test";
import assert from "node:assert/strict";
import { audio, record, request, volume, resetAll } from "../testkit/system.mjs";

const { recordAudio, recordingCapability, cancelRecording, resetFrameSupport } = await import("../src/common/audio.js");
const { speak, stopSpeaking, mediaVolume, lastPlaybackReport } = await import("../src/common/speech.js");
const { applyRemoteRuntime } = await import("../src/common/settings.js");

// Потоковый режим держит весь PCM в куче часов, поэтому он выключен по
// умолчанию и включается только явным autoStop со шлюза.
function enableAutoStop() {
  return new Promise((resolve) => applyRemoteRuntime({ autoStop: true }, resolve));
}

function disableAutoStop() {
  return new Promise((resolve) => applyRemoteRuntime({ autoStop: false }, resolve));
}

// Фиксированная пауза здесь была источником мигания: добавление ещё одного
// асинхронного шага в speak() (чтение громкости) сдвигало тайминг, и под
// нагрузкой 20 мс переставало хватать. Ждём условие, а не время.
const speechErrors = [];

function resetSpeech() {
  speechErrors.length = 0;
}

function finishPlayback() {
  if (audio.onended) audio.onended();
}

async function waitFor(condition, what) {
  for (let i = 0; i < 200; i++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`не дождались: ${what}`);
}

test("по умолчанию запись идёт файловым путём, а не потоковым", async () => {
  resetAll();
  resetFrameSupport();
  await disableAutoStop();
  record.scripted = { result: { uri: "internal://cache/rec-default.opus" } };
  const formats = [];
  const originalStart = record.start;
  record.start = (options) => { formats.push(options.format); return originalStart.call(record, options) };
  const result = await new Promise((resolve, reject) => recordAudio(resolve, reject));
  record.start = originalStart;
  assert.deepEqual(formats, ["opus"]);
  assert.equal(result.uri, "internal://cache/rec-default.opus");
});

test("синхронный отказ записи возвращается как ошибка, а не вешает экран", async () => {
  resetAll();
  record.throwOnStart = true;
  const error = await new Promise((resolve) => recordAudio(() => resolve(null), resolve));
  assert.match(error.message, /начать запись|record unavailable/i);
});

test("кадры PCM собираются в WAV и возвращают отчёт автостопа", async () => {
  resetAll();
  await enableAutoStop();
  const speech = new Uint8Array(2048);
  for (let i = 0; i < speech.length; i += 2) {
    speech[i] = 0x20;
    speech[i + 1] = 0x03;
  }
  record.scripted = { frames: [speech, new Uint8Array(2048)] };
  const audioFile = await new Promise((resolve, reject) => recordAudio(resolve, reject));
  assert.equal(audioFile.contentType, "audio/wav");
  assert.ok(audioFile.bytes instanceof ArrayBuffer);
  assert.equal(new Uint8Array(audioFile.bytes)[0], 0x52);
  assert.equal(audioFile.capture.mode, "pcm-auto-stop");
  assert.equal(audioFile.capture.frameCount, 2);
  assert.equal(recordingCapability().last.frameCount, 2);
});

test("явная отмена framed-записи до первого кадра не запускает fallback", async () => {
  resetAll();
  await enableAutoStop();
  record.scripted = { frames: [] };
  let completed = false;
  let failed = false;
  recordAudio(() => { completed = true }, () => { failed = true });
  cancelRecording();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(completed, false);
  assert.equal(failed, false);
  assert.equal(recordingCapability().last.mode, "pcm-auto-stop");
});

// Прошивка объявляет слот onframerecorded, но кадров не шлёт и отдаёт запись
// обычным success(uri). Такой случай вешал экран на 18 секунд сторожевого
// таймера, а потом молча включал микрофон второй раз.
test("прошивка без кадров отвечает сразу и одной записью", async () => {
  resetAll();
  resetFrameSupport();
  await enableAutoStop();
  record.scripted = { result: { uri: "internal://cache/rec-1.opus" } };
  const originalStart = record.start;
  let starts = 0;
  record.start = (options) => { starts += 1; return originalStart.call(record, options) };
  const startedAt = Date.now();
  const result = await new Promise((resolve, reject) => recordAudio(resolve, reject));
  const elapsed = Date.now() - startedAt;
  record.start = originalStart;
  assert.ok(elapsed < 2000, `запись не должна ждать сторожевой таймер, ждали ${elapsed} мс`);
  assert.equal(starts, 1, "микрофон включается один раз, а не второй раз молча");
  assert.equal(result.uri, "internal://cache/rec-1.opus");
  assert.equal(result.capture.mode, "pcm-no-frames-file");
});

test("после записи без кадров потоковый режим больше не пробуется", async () => {
  resetAll();
  resetFrameSupport();
  await enableAutoStop();
  record.scripted = { result: { uri: "internal://cache/rec-1.opus" } };
  await new Promise((resolve, reject) => recordAudio(resolve, reject));
  assert.equal(recordingCapability().framedUnsupported, true);

  const originalStart = record.start;
  const formats = [];
  record.start = (options) => { formats.push(options.format); return originalStart.call(record, options) };
  await new Promise((resolve, reject) => recordAudio(resolve, reject));
  record.start = originalStart;
  assert.deepEqual(formats, ["opus"], "второй заход идёт сразу файловым путём");
});

// Куча часов — жёсткая граница: документация @system.file прямо называет
// переполнение памяти причиной падения приложения. Даже если прошивка шлёт
// кадры дольше, чем отрабатывает record.stop(), в памяти не окажется больше
// потолка.
test("поток кадров обрезается по потолку памяти, а не копится бесконечно", async () => {
  resetAll();
  resetFrameSupport();
  await enableAutoStop();
  const loud = new Uint8Array(4096);
  for (let i = 0; i < loud.length; i += 2) { loud[i] = 0x20; loud[i + 1] = 0x03 }
  // 60 кадров по 4 КиБ = 240 КиБ, потолок — 96 КиБ.
  record.scripted = { frames: Array.from({ length: 60 }, () => loud) };
  const result = await new Promise((resolve, reject) => recordAudio(resolve, reject));
  const wavBytes = new Uint8Array(result.bytes).length - 44;
  assert.ok(wavBytes <= 96 * 1024, `в памяти осело ${wavBytes} байт при потолке ${96 * 1024}`);
  assert.equal(result.capture.stoppedByLimit, true);
  assert.equal(result.capture.totalBytes, wavBytes);
});

test("отчёт сохраняет marker PCM->Opus fallback", async () => {
  resetAll();
  resetFrameSupport();
  await enableAutoStop();
  const originalStart = record.start;
  let starts = 0;
  record.start = (options) => {
    starts += 1;
    setTimeout(() => {
      if (options.format === "pcm") options.complete && options.complete();
      else options.success && options.success({ uri: "internal://cache/fallback.opus" });
    }, 0);
  };
  const result = await new Promise((resolve, reject) => recordAudio(resolve, reject));
  record.start = originalStart;
  assert.equal(result.capture.mode, "file-opus-fallback");
  assert.equal(recordingCapability().last.mode, "file-opus-fallback");
});

// Нулевая громкость выглядит ровно как сломанная озвучка — тишина. Часы
// обязаны назвать причину, а не молчать.
test("нулевая громкость объясняется словами и не тратит загрузку", async () => {
  resetAll();
  volume.value = 0;
  request.downloadResult = { result: { token: "download-silent" } };
  const error = await new Promise((resolve) => speak("speech-1", () => resolve(null), resolve));
  assert.match(error.message, /Звук на часах/i);
  assert.equal(request.downloadCalls.length, 0, "качать озвучку, которую не слышно, незачем");
});

test("отсутствие модуля громкости не блокирует озвучку", async () => {
  resetAll();
  volume.available = false;
  const value = await new Promise((resolve) => mediaVolume(resolve));
  assert.equal(value, -1);
  resetSpeech();
  request.downloadResult = { result: { token: "download-novol" } };
  request.completeResult = { result: { uri: "internal://files/reply.wav" } };
  speak("speech-1", () => {}, (error) => speechErrors.push(error.message));
  await waitFor(() => audio.playCalls === 1, "воспроизведение началось");
  finishPlayback();
  assert.deepEqual(speechErrors, []);
});

test("начало воспроизведения фиксируется для диагностики", async () => {
  resetAll();
  resetSpeech();
  request.downloadResult = { result: { token: "download-report" } };
  request.completeResult = { result: { uri: "internal://files/reply.wav" } };
  speak("speech-report", () => {}, (error) => speechErrors.push(error.message));
  await waitFor(() => lastPlaybackReport().started, "воспроизведение отмечено начатым");
  const report = lastPlaybackReport();
  finishPlayback();
  assert.deepEqual(speechErrors, []);
  assert.equal(report.started, true);
  assert.equal(report.volume, 0.6);
});

test("синхронный отказ загрузки озвучки возвращается как ошибка", async () => {
  resetAll();
  request.throwOnDownload = true;
  const error = await new Promise((resolve) => speak("speech-1", () => resolve(null), resolve));
  assert.match(error.message, /начать загрузку/i);
});

test("синхронный отказ завершения загрузки озвучки возвращается как ошибка", async () => {
  resetAll();
  request.downloadResult = { result: { token: "download-1" } };
  request.throwOnComplete = true;
  const error = await new Promise((resolve) => speak("speech-1", () => resolve(null), resolve));
  assert.match(error.message, /получить файл/i);
});

test("озвучка остаётся активной до ended и затем завершает UI-состояние", async () => {
  resetAll();
  request.downloadResult = { result: { token: "download-1" } };
  request.completeResult = { result: { uri: "internal://files/reply.wav" } };
  let finished = false;
  speak("speech-1", () => { finished = true; }, (error) => speechErrors.push(error.message));
  await waitFor(() => audio.playCalls === 1, "воспроизведение началось");
  assert.equal(finished, false, "done не должен срабатывать сразу после audio.play()");
  audio.onended();
  assert.equal(finished, true);
});

test("остановка озвучки завершает активное UI-состояние", async () => {
  resetAll();
  request.downloadResult = { result: { token: "download-1" } };
  request.completeResult = { result: { uri: "internal://files/reply.wav" } };
  let finished = false;
  speak("speech-1", () => { finished = true; }, (error) => speechErrors.push(error.message));
  await waitFor(() => audio.playCalls === 1, "воспроизведение началось");
  stopSpeaking();
  assert.equal(finished, true);
});

test("озвучка читает формат шлюза как hint запроса", async () => {
  resetAll();
  await new Promise((resolve) => applyRemoteRuntime({ ttsFormat: "mp3" }, resolve));
  request.downloadResult = { result: { token: "download-format" } };
  request.completeResult = { result: { uri: "internal://files/reply.mp3" } };
  resetSpeech();
  speak("speech-format", () => {}, (error) => speechErrors.push(error.message));
  await waitFor(() => request.downloadCalls.length > 0, "запрос озвучки ушёл");
  assert.match(request.downloadCalls[0].url, /\/api\/v1\/speak\/speech-format\?format=mp3$/);
  stopSpeaking();
});
