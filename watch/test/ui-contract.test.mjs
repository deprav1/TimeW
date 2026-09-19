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

// Документация Vela по памяти: «Clear unfinished timers when the page is
// destroyed». Счётчик главного экрана — setInterval, он пережил бы уход со
// страницы и держал бы всю вьюмодель.
test("main screen clears its timers when the page is destroyed", async () => {
  const source = await page("index")
  assert.match(source, /onDestroy\(\)\s*\{/)
  const destroy = source.slice(source.indexOf("onDestroy()"))
  assert.match(destroy.slice(0, 300), /stopTicker\(\)/)
  assert.match(destroy.slice(0, 300), /clearTimeout\(this\.undoTimer\)/)
})

// Там же: onShow срабатывает заново при каждом включении экрана, поэтому
// запрос в нём должен быть под ограничителем частоты.
test("main screen does not refetch status on every screen wake", async () => {
  const source = await page("index")
  const show = source.slice(source.indexOf("onShow()"), source.indexOf("onDestroy()"))
  const throttle = show.indexOf("lastSyncAt")
  const fetchCall = show.indexOf("fetchStatus(")
  assert.ok(throttle > -1 && fetchCall > -1, "ожидались и ограничитель, и запрос статуса")
  assert.ok(throttle < fetchCall, "fetchStatus должен стоять после проверки lastSyncAt")
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
