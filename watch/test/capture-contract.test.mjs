import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(new URL("../src/manifest.json", import.meta.url), "utf8"));
const capture = readFileSync(new URL("../src/pages/capture/capture.ux", import.meta.url), "utf8");
const index = readFileSync(new URL("../src/pages/index/index.ux", import.meta.url), "utf8");
const notes = readFileSync(new URL("../src/pages/notes/notes.ux", import.meta.url), "utf8");

test("cold entry is the normal home page and capture stays an isolated route", () => {
  assert.equal(manifest.router.entry, "pages/index");
  assert.deepEqual(manifest.router.pages["pages/capture"], { component: "capture" });
});

test("capture bundle imports no rich runtime modules before record.start", () => {
  assert.match(capture, /from "@system\.record"/);
  assert.match(capture, /from "@system\.fetch"/);
  assert.match(capture, /from "@system\.router"/);
  for (const forbidden of [
    "@system.audio", "@system.file", "@system.request", "@system.uploadtask",
    "@system.storage", "@system.volume", "../../common/api", "../../common/audio",
    "../../common/speech", "../../common/settings"
  ]) {
    assert.equal(capture.includes(forbidden), false, `capture must not import ${forbidden}`);
  }
  assert.match(capture, /record\.start\(request\)/);
});

test("Vela background audio and request interfaces stay declared globally", () => {
  assert.deepEqual(manifest.config?.background?.features, ["system.audio", "system.request"]);
});

test("rich pages hand new voice capture back to the isolated entry", () => {
  assert.equal(index.includes("../../common/audio"), false);
  assert.equal(index.includes("../../common/speech"), false);
  assert.match(index, /uri: "\/pages\/capture"/);
  assert.match(index, /consumeCapture\(\)/);
  assert.equal(notes.includes("../../common/audio"), false);
  assert.match(notes, /returnTo: "notes"/);
  assert.match(notes, /consumeCapture\(\)/);
});

test("capture handoff keeps the server contract inputs", () => {
  assert.match(capture, /captureUri: uri/);
  assert.match(capture, /captureContentType: "audio\/opus"/);
  assert.match(capture, /captureRecordedMs: String/);
  assert.match(index, /voiceUri\(uri, self\.captureContentType/);
  assert.match(notes, /voiceUri\(uri, self\.captureContentType/);
});
