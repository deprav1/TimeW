import storage from "@system.storage"

// Офлайн-очередь заметок поверх @system.storage. Когда отправка не удалась
// из-за связи, заметка не теряется, а копится здесь до следующей попытки.
//
// Массив хранится как одна JSON-строка под одним ключом: storage в Vela
// умеет только строки, а отдельный ключ на запись плодил бы неограниченно
// растущий список ключей без возможности их перечислить.

var STORAGE_KEY = "pendingNotes"
var MAX_QUEUE_SIZE = 50

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

function deserialize(raw) {
  if (!raw) return []
  try {
    var parsed = JSON.parse(raw)
    if (Object.prototype.toString.call(parsed) === "[object Array]") return parsed
    return []
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

export function enqueue(text, done) {
  if (!text) {
    if (done) done(cache)
    return
  }
  var item = { id: makeId(), text: text, createdAt: new Date().toISOString() }
  var next = cache.concat([item])
  if (next.length > MAX_QUEUE_SIZE) {
    next = next.slice(next.length - MAX_QUEUE_SIZE)
  }
  cache = next
  persist(cache, function() {
    if (done) done(cache)
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

  function finish() {
    flushing = false
    if (done) done(sent, cache.length)
  }

  function step() {
    if (cache.length === 0) {
      finish()
      return
    }
    var item = cache[0]
    sendOne(item, function() {
      removeFromCache(item.id)
      sent += 1
      persist(cache, function() {
        step()
      })
    }, finish)
  }

  step()
}
