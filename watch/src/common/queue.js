import storage from "@system.storage"

// Офлайн-очередь заметок поверх @system.storage. Когда отправка не удалась
// из-за связи, заметка не теряется, а копится здесь до следующей попытки.
//
// Массив хранится как одна JSON-строка под одним ключом: storage в Vela
// умеет только строки, а отдельный ключ на запись плодил бы неограниченно
// растущий список ключей без возможности их перечислить.
//
// В очереди два вида элементов:
//   kind "text"  — текст заметки, когда распознавание уже прошло;
//   kind "audio" — сама запись (uri файла на часах), когда сети не было
//                  вовсе. Это основной случай на часах без eSIM: речь
//                  распознаёт шлюз, поэтому без сети текста взяться неоткуда,
//                  и сохранить можно только звук.
//
// Записи живут в кэше приложения, и рантайм вправе их убрать. Поэтому у
// звуковых элементов есть срок годности, а исчезнувший файл удаляется из
// очереди, а не застревает в ней навсегда.

var STORAGE_KEY = "pendingNotes"
var MAX_QUEUE_SIZE = 50
var AUDIO_TTL_MS = 7 * 24 * 60 * 60 * 1000

var cache = []
var counter = 0

function makeId() {
  counter += 1
  return String(Date.now()) + "-" + String(counter)
}

function serialize(list) {
  try {
    return JSON.stringify(list)
  } catch (error) {
    return "[]"
  }
}

// Старые элементы лежат без поля kind — считаем их текстовыми, чтобы
// обновление приложения не потеряло то, что уже стоит в очереди.
function normalizeItem(item) {
  if (!item || typeof item !== "object") return null
  if (!item.kind) item.kind = "text"
  if (item.kind === "audio" && !item.uri) return null
  if (item.kind === "text" && !item.text) return null
  return item
}

function isFresh(item) {
  if (item.kind !== "audio") return true
  var created = Date.parse(item.createdAt)
  if (!created) return true
  return Date.now() - created < AUDIO_TTL_MS
}

function deserialize(raw) {
  if (!raw) return []
  try {
    var parsed = JSON.parse(raw)
    if (Object.prototype.toString.call(parsed) !== "[object Array]") return []
    var result = []
    for (var i = 0; i < parsed.length; i++) {
      var item = normalizeItem(parsed[i])
      if (item && isFresh(item)) result.push(item)
    }
    return result
  } catch (error) {
    return []
  }
}

function persist(list, done) {
  storage.set({
    key: STORAGE_KEY,
    value: serialize(list),
    success: function() { if (done) done(true) },
    fail: function() { if (done) done(false) }
  })
}

// Читает очередь из storage в кэш при старте приложения. Любая ошибка
// storage не должна ронять приложение — продолжаем с пустой очередью.
export function loadQueue(done) {
  storage.get({
    key: STORAGE_KEY,
    success: function(raw) {
      cache = deserialize(raw)
      if (done) done(cache)
    },
    fail: function() {
      cache = []
      if (done) done(cache)
    }
  })
}

// Синхронный доступ к текущему кэшу — по образцу getCached() в settings.js,
// чтобы интерфейс мог показать очередь без колбэков.
export function getQueued() {
  return cache
}

export function enqueue(text, done, fail, requestId) {
  if (!text) {
    if (done) done(cache)
    return
  }
  push({ kind: "text", text: text, requestId: requestId || makeId() }, done, fail)
}

// Откладывает саму запись: сети нет, распознать некому, но голос человека
// терять нельзя. requestId фиксируется здесь и переживает перезапуск, чтобы
// повторная досылка не создала вторую заметку.
export function enqueueAudio(uri, contentType, done, fail) {
  if (!uri) {
    if (done) done(cache)
    return
  }
  push({ kind: "audio", uri: uri, contentType: contentType || "", requestId: makeId() }, done, fail)
}

function push(fields, done, fail) {
  var item = { id: makeId(), createdAt: new Date().toISOString() }
  Object.keys(fields).forEach(function(key) { item[key] = fields[key] })
  var next = cache.concat([item])
  if (next.length > MAX_QUEUE_SIZE) {
    next = next.slice(next.length - MAX_QUEUE_SIZE)
  }
  var previous = cache
  cache = next
  persist(cache, function(ok) {
    if (ok) {
      if (done) done(cache)
    } else if (fail) {
      cache = previous
      fail(new Error("Не удалось сохранить заметку на часах"))
    }
  })
}

function removeFromCache(id) {
  var next = []
  for (var i = 0; i < cache.length; i++) {
    if (cache[i].id !== id) next.push(cache[i])
  }
  cache = next
}

// Пытается отправить очередь по одному элементу за раз через sendOne, которую
// предоставляет вызывающий код (в index.ux это query("Запиши: " + text)).
// При успехе элемент удаляется из очереди и storage; при ошибке отправка
// прекращается — остальные остаются в очереди, чтобы не долбить мёртвый
// шлюз повторными попытками на каждый успешный запрос.
// Досылка запускается из нескольких мест (открытие экрана, успешный запрос,
// удаление заметки). Без этого флага две параллельные досылки взяли бы из
// очереди один и тот же первый элемент и создали дубль заметки.
var flushing = false

export function flush(sendOne, done) {
  if (flushing) {
    if (done) done(0, cache.length)
    return
  }
  flushing = true
  var sent = 0
  var dropped = 0

  function finish() {
    flushing = false
    if (done) done(sent, cache.length, dropped)
  }

  function step() {
    if (cache.length === 0) {
      finish()
      return
    }
    var item = cache[0]

    // drop — элемент отправить невозможно в принципе (файл записи пропал).
    // Он убирается из очереди, и досылка идёт дальше: иначе один потерянный
    // файл навсегда заблокировал бы всё, что стоит за ним.
    function remove(counts, next) {
      var previous = cache
      removeFromCache(item.id)
      if (counts) sent += 1
      persist(cache, function(ok) {
        if (ok === false) {
          cache = previous
          if (counts) sent -= 1
          finish()
          return
        }
        next()
      })
    }

    sendOne(
      item,
      function() { remove(true, step) },
      finish,
      function() {
        dropped += 1
        remove(false, step)
      }
    )
  }

  step()
}
