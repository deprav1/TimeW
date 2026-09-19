import test from "node:test";
import assert from "node:assert/strict";
import { audio, record, request, resetAll } from "../testkit/system.mjs";

const { recordAudio, recordingCapability } = await import("../src/common/audio.js");
const { speak, stopSpeaking } = await import("../src/common/speech.js");

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
