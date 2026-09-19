import test from "node:test";
import assert from "node:assert/strict";
import { audio, record, request, resetAll } from "../testkit/system.mjs";

const { recordAudio, recordingCapability, cancelRecording } = await import("../src/common/audio.js");
const { speak, stopSpeaking } = await import("../src/common/speech.js");
const { applyRemoteRuntime } = await import("../src/common/settings.js");

test("синхронный отказ записи возвращается как ошибка, а не вешает экран", async () => {
  resetAll();
  record.throwOnStart = true;
  const error = await new Promise((resolve) => recordAudio(() => resolve(null), resolve));
  assert.match(error.message, /начать запись|record unavailable/i);
});

test("кадры PCM собираются в WAV и возвращают отчёт автостопа", async () => {
  resetAll();
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

test("отчёт сохраняет marker PCM->Opus fallback", async () => {
  resetAll();
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
  speak("speech-1", () => { finished = true; }, (error) => assert.fail(error.message));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(audio.playCalls, 1);
  assert.equal(finished, false, "done не должен срабатывать сразу после audio.play()");
  audio.onended();
  assert.equal(finished, true);
});

test("остановка озвучки завершает активное UI-состояние", async () => {
  resetAll();
  request.downloadResult = { result: { token: "download-1" } };
  request.completeResult = { result: { uri: "internal://files/reply.wav" } };
  let finished = false;
  speak("speech-1", () => { finished = true; }, (error) => assert.fail(error.message));
  await new Promise((resolve) => setTimeout(resolve, 20));
  stopSpeaking();
  assert.equal(finished, true);
});

test("озвучка читает формат шлюза как hint запроса", async () => {
  resetAll();
  await new Promise((resolve) => applyRemoteRuntime({ ttsFormat: "mp3" }, resolve));
  request.downloadResult = { result: { token: "download-format" } };
  request.completeResult = { result: { uri: "internal://files/reply.mp3" } };
  speak("speech-format", () => {}, (error) => assert.fail(error.message));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.match(request.downloadCalls[0].url, /\/api\/v1\/speak\/speech-format\?format=mp3$/);
  stopSpeaking();
});
