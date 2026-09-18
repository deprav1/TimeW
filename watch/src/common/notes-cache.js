import storage from "@system.storage"
import { guard } from "./guard"

var STORAGE_TIMEOUT_MS = 1000

// Последний известный список заметок, сохранённый на часах.
//
// Зачем: без сети приложение показывало только ошибку «Не удалось загрузить
// заметки» — и переставало быть полезным целиком, хотя заметки человек уже
// видел пять минут назад. На часах без eSIM отсутствие сети не авария, а
// обычное состояние вне дома, поэтому последний список держим локально и
// показываем с пометкой, что он несвежий.
//
// Кэш — не источник правды: как только шлюз ответил, список берётся у него.

var STORAGE_KEY = "cachedNotes"
// Больше на круглый экран всё равно не влезает, а класть в storage мегабайты
// смысла нет: это память часов.
var MAX_CACHED = 20

var cache = null

function serialize(list) {
  try {
    return JSON.stringify(list)
  } catch (error) {
    return ""
  }
}

function deserialize(raw) {
  if (!raw) return null
  try {
    var parsed = JSON.parse(raw)
    if (Object.prototype.toString.call(parsed) !== "[object Array]") return null
    var result = []
    for (var i = 0; i < parsed.length; i++) {
      var note = parsed[i]
      // Заметка без id и текста бесполезна и сломает список.
      if (note && note.id && typeof note.text === "string") result.push(note)
    }
    return result
  } catch (error) {
    return null
  }
}

// done(notes | null). null означает «кэша нет», и это не то же самое, что
// пустой список: пустой — «заметок нет», null — «мы не знаем».
export function loadCachedNotes(done) {
  var settle = guard(STORAGE_TIMEOUT_MS, function() {
    cache = null
    if (done) done(null)
  })
  try {
    storage.get({
      key: STORAGE_KEY,
      success: settle(function(raw) {
        cache = deserialize(raw)
        if (done) done(cache)
      }),
      fail: settle(function() {
        cache = null
        if (done) done(null)
      })
    })
  } catch (error) {
    settle(function() {
      cache = null
      if (done) done(null)
    })()
  }
}

export function getCachedNotes() {
  return cache
}

// Сохраняет молча: неудачная запись кэша не повод показывать человеку ошибку,
// список у него уже на экране.
export function saveCachedNotes(notes, done) {
  var list = (notes || []).slice(0, MAX_CACHED).map(function(note) {
    return { id: note.id, text: note.text, createdAt: note.createdAt }
  })
  cache = list
  var value = serialize(list)
  if (!value) {
    if (done) done(false)
    return
  }
  var settle = guard(STORAGE_TIMEOUT_MS, function() { if (done) done(false) })
  try {
    storage.set({
      key: STORAGE_KEY,
      value: value,
      success: settle(function() { if (done) done(true) }),
      fail: settle(function() { if (done) done(false) })
    })
  } catch (error) {
    settle(function() { if (done) done(false) })()
  }
}
