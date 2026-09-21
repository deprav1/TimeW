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
  assert.match(source, /if="\{\{homeAvailable\}\}" onclick="startHome"/)
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

// Кнопка «Заметка» рядом с «Дом» должна вести себя так же — начинать запись,
// а не молча открывать список и ждать второго нажатия.
test("the Note button starts dictation instead of only opening the list", async () => {
  const index = await page("index")
  assert.match(index, /autoDictate:\s*"1"/)
  const notes = await page("notes")
  assert.match(notes, /autoDictate/)
  assert.match(notes, /self\.dictate\(\)/)
})

// Отчёт диагностики — единственный канал с устройства, и молчать об отказах
// он не должен.
test("diagnostics report carries failures, not only successes", async () => {
  const source = await page("diag")
  assert.match(source, /report\.recordError/)
  assert.match(source, /report\.speechTest/)
  assert.match(source, /lastSpeechReport\(\)/)
  assert.match(source, /probe\("uploadtask"/)
  assert.match(source, /report\.lastVoice/)
  assert.match(source, /speakTest\(/)
})

test("answer screen never exposes a dead speech control", async () => {
  const source = await page("answer")
  assert.match(source, /if="\{\{canSpeak\}\}"/) 
  assert.match(source, /speakLabel/)
  assert.match(source, /Назад/)
})

// Заметку читают и удаляют на экране ответа: в диалоге помещалось только
// начало текста, а подтверждать удаление, видя одну строку, — значит
// подтверждать вслепую.
test("notes open for full reading, and deleting happens next to the text", async () => {
  const notes = await page("notes")
  assert.match(notes, /openNote\(\$item\.id\)/)
  assert.match(notes, /note-date/)
  assert.match(notes, /uri: "\/pages\/answer"/)
  assert.match(notes, /noteId: id/)
  assert.doesNotMatch(notes, /prompt\.showDialog[\s\S]{0,200}Удалить/, "список не подтверждает удаление вслепую")
  const answer = await page("answer")
  assert.match(answer, /if="\{\{canDelete\}\}"/)
  assert.match(answer, /Удалить заметку\?/)
  assert.match(answer, /deleteNote\(self\.noteId/)
})

test("diagnostics run and stop from one large target", async () => {
  const source = await page("diag")
  assert.match(source, /progressText/)
  // Отдельной кнопки «Остановить» нет: на круглом экране этот ряд стоил бы
  // строки отчёта. Повторное нажатие по идущей проверке останавливает её.
  assert.match(source, /run\(\)\s*\{[\s\S]*?if \(self\.busy\)\s*\{[\s\S]*?self\.cancelRun\(\)/)
  assert.match(source, /<div class="run-button" onclick="run">/)
  assert.match(source, /\.run-button\s*\{[^}]*width:\s*370px[^}]*height:\s*96px/)
  assert.match(source, /\.diag-scroll\s*\{[^}]*height:\s*\d+px/)
})

// Круг 480 даёт 265px ширины на y=45, 374px на y=90 и все 480 в середине.
// Отсюда два правила: страница всегда во весь экран (иначе рантайм прижимает
// содержимое влево и левый край уходит под рамку), а ни один блок не шире
// 370 — столько круг держит в полосе, где вообще стоит что-то размещать.
test("round-screen pages fill the screen and keep every block inside the circle", async () => {
  for (const name of ["index", "answer", "notes", "settings", "diag", "capture"]) {
    const source = await page(name)
    assert.match(source, /\.page\s*\{[\s\S]*?flex-direction:\s*column/)
    assert.doesNotMatch(source, /width:\s*100%/, `${name} must not stretch critical page children`)
    assert.match(source, /\.page\s*\{[^}]*width:\s*480px/, `${name} page must span the full screen`)
    assert.match(source, /\.page\s*\{[^}]*justify-content:\s*center/, `${name} must center its column vertically`)
    const widths = [...source.matchAll(/width:\s*(\d+)px/g)].map((m) => Number(m[1]))
    // 400px проходят только в середине (y 108…372), где круг шире 408;
    // верхние и нижние ряды в каждом файле сужены до 276 вручную и
    // проверены скриншотом эмулятора.
    const tooWide = widths.filter((value) => value > 400 && value !== 480)
    assert.deepEqual(tooWide, [], `${name} has children wider than the circle allows`)
  }
})

// Подтверждено эмулятором и фотографией с часов: linear-gradient рантайм не
// рисует вовсе (кнопка оставалась прозрачной, тёмная подпись исчезала), а
// box-shadow на устройстве превращался в широкое кольцо вокруг невидимой
// кнопки. Заливка — только сплошным цветом.
test("watch pages paint with flat colors the runtime can actually draw", async () => {
  for (const name of ["index", "answer", "notes", "settings", "diag", "capture"]) {
    const source = await page(name)
    // Ищем именно объявления: слова «linear-gradient» и «box-shadow» должны
    // оставаться в комментариях, объясняющих, почему их тут нет.
    assert.doesNotMatch(source, /background-image:\s*linear-gradient/, `${name} uses a gradient the runtime does not paint`)
    assert.doesNotMatch(source, /box-shadow:\s*\S/, `${name} uses a shadow the device renders as a ring`)
  }
})

// Скролл — такой же div: без flex-direction рантайм раскладывает строки в
// ряд. На экране настроек из-за этого оставалась одна строка «Сеть», уехавшая
// к правому краю, а остальные были за пределами экрана.
test("scroll regions declare a column direction", async () => {
  for (const name of ["answer", "notes", "diag"]) {
    const source = await page(name)
    const classes = [...source.matchAll(/<scroll class="([\w-]+)"/g)].map((m) => m[1])
    assert.ok(classes.length, `${name} has no scroll region`)
    for (const cssClass of classes) {
      const rule = source.match(new RegExp("\\." + cssClass + "\\s*\\{[^}]*\\}"))
      assert.ok(rule, `${name} misses a rule for .${cssClass}`)
      assert.match(rule[0], /flex-direction:\s*column/, `.${cssClass} would lay its rows out sideways`)
    }
  }
})

// Проверено в эмуляторе: list и list-item в этой сборке Vela не рисуются
// вовсе — ни сами по себе, ни внутри scroll. Экран ответа оставался пустым,
// пока список не заменили на scroll с обычными div.
test("pages build their lists from scroll and plain divs", async () => {
  for (const name of ["index", "answer", "notes", "settings", "diag"]) {
    const source = await page(name)
    assert.doesNotMatch(source, /<list[\s>]/, `${name} uses a list element the runtime ignores`)
    assert.doesNotMatch(source, /<list-item/, `${name} uses list-item, which never renders`)
  }
  const answer = await page("answer")
  assert.match(answer, /<scroll class="answer-scroll"[^>]*>[\s\S]*?<div class="answer-item"/)
  assert.match(answer, /\.answer-scroll\s*\{[^}]*width:\s*370px[^}]*height:\s*260px/)
  const notes = await page("notes")
  assert.match(notes, /<div class="note-item" for="\{\{visibleNotes\}\}"/)
  const diag = await page("diag")
  assert.match(diag, /<div class="line" for="\{\{lines\}\}">/)
})

// Настройки помещаются без прокрутки намеренно: ввод в эмуляторе до рантайма
// не доходит, проверить прокрутку нечем, а строка, до которой нельзя
// доскроллить, ничем не отличается от отсутствующей.
test("settings fit four full-width rows without scrolling", async () => {
  const source = await page("settings")
  assert.doesNotMatch(source, /<scroll/, "settings must not hide rows behind an unverifiable scroll")
  assert.equal((source.match(/class="row"/g) || []).length, 3)
  assert.match(source, /class="row diag-row"/)
  assert.match(source, /\.row\s*\{[^}]*width:\s*340px[^}]*height:\s*68px/)
  // «Начать заново» ушло сюда с главного экрана, где было мелкой подписью.
  assert.match(source, /onclick="resetDialogue"/)
  assert.match(source, /resetDialog\(/)
})

// Ни одной цели меньше 68px и ни одной подписи вместо кнопки: по тексту
// высотой в шрифт на часах не попасть — об этом пришла жалоба с устройства.
test("every tappable target on the watch is at least 68px tall", async () => {
  const selectors = {
    index: ["nav-button", "quick-button", "wide-button", "talk-button", "talk-busy", "answer-area"],
    answer: ["action-button", "delete-button", "back-button"],
    notes: ["back-button", "dictate-button", "dictate-busy", "page-button", "note-item"],
    settings: ["top-button", "row"],
    diag: ["top-button", "run-button", "run-busy"],
    capture: ["back-button", "capture-button"]
  }
  for (const [name, list] of Object.entries(selectors)) {
    const source = await page(name)
    for (const selector of list) {
      const match = source.match(new RegExp("\\." + selector + "\\s*\\{[^}]*height:\\s*(\\d+)px"))
      assert.ok(match, `${name}: missing ${selector} geometry`)
      assert.ok(Number(match[1]) >= 68, `${name}: ${selector} is ${match[1]}px, below the 68px floor`)
    }
  }
  // Кликабельного текста на главном экране больше нет, кроме «читать
  // полностью» внутри крупной области ответа, которая сама является целью.
  const index = await page("index")
  const clickableText = [...index.matchAll(/<text[^>]*onclick="(\w+)"/g)].map((m) => m[1])
  assert.deepEqual(clickableText, ["openAnswer"], "main screen must not use small text links")
})

// scroll в этой сборке не обрезает содержимое, а прокрутку проверить нечем:
// длинный ответ залезал на кнопку «Назад», а третья заметка уходила под
// рамку. Поэтому оба длинных экрана листаются явно.
test("long content is paged, never left to an unverifiable scroll", async () => {
  const answer = await page("answer")
  assert.match(answer, /function paginate\(/)
  assert.match(answer, /onclick="nextPage"/)
  assert.match(answer, /\.answer-item\s*\{[^}]*height:\s*256px/)
  const notes = await page("notes")
  assert.match(notes, /visibleNotes = this\.notes\.slice\(/)
  assert.match(notes, /onclick="pageOrRefresh"/)
})

test("main action stays one bound class without a native arc", async () => {
  const source = await page("index")
  assert.doesNotMatch(source, /type="arc"/)
  assert.match(source, /class="\{\{talkClass\}\}" onclick="talk"/)
  assert.match(source, /\.talk-button\s*\{[^}]*width:\s*400px/)
})
