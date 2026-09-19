import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(fileURLToPath(new URL("../src/pages/", import.meta.url)))

async function page(name) {
  return readFile(join(root, name, `${name}.ux`), "utf8")
}

test("main screen keeps the high-frequency actions large and explicit", async () => {
  const source = await page("index")
  assert.match(source, /startHome\(\)/)
  assert.match(source, /startNote\(\)/)
  assert.match(source, /Отменить действие/)
  assert.match(source, /showCancel/)
  assert.match(source, /homeAvailable/)
  assert.match(source, /Дом · нет/)
  assert.doesNotMatch(source, /onclick="unstick"\s*class="status"/)
})

test("answer screen never exposes a dead speech control", async () => {
  const source = await page("answer")
  assert.match(source, /if="\{\{canSpeak\}\}"/) 
  assert.match(source, /speakLabel/)
  assert.match(source, /Назад/)
})

test("notes expose full reading and metadata affordances", async () => {
  const source = await page("notes")
  assert.match(source, /openNote\(\$item\.id\)/)
  assert.match(source, /note-date/)
  assert.match(source, /Удалить/)
})

test("diagnostics have visible progress and cancellation", async () => {
  const source = await page("diag")
  assert.match(source, /progressText/)
  assert.match(source, /cancelRun\(\)/)
  assert.match(source, /Остановить проверку/)
})
