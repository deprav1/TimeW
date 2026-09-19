import storage from "@system.storage"
import file from "@system.file"
import { guard } from "./guard"

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
// Запись сначала переносится из internal://cache в internal://files. Если
// рантайм не поддерживает копирование, сохраняется исходный URI как
// совместимый fallback; исчезнувший файл тогда удаляется из очереди, а не
// застревает в ней навсегда.

var STORAGE_KEY = "pendingNotes"
var MAX_QUEUE_SIZE = 50
var AUDIO_TTL_MS = 7 * 24 * 60 * 60 * 1000
var FILE_COPY_TIMEOUT_MS = 5000
var STORAGE_TIMEOUT_MS = 1000

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
  var settle = guard(STORAGE_TIMEOUT_MS, function() { if (done) done(false) })
  try {
    storage.set({
      key: STORAGE_KEY,
      value: serialize(list),
      success: settle(function() { if (done) done(true) }),
      fail: settle(function() { if (done) done(false) })
    })
  } catch (error) {
    settle(function() { if (done) done(false) })()
  }
}

// Читает очередь из storage в кэш при старте приложения. Любая ошибка
// storage не должна ронять приложение — продолжаем с пустой очередью.
export function loadQueue(done) {
  var settle = guard(STORAGE_TIMEOUT_MS, function() {
    cache = []
    if (done) done(cache)
  })
  try {
    storage.get({
      key: STORAGE_KEY,
      success: settle(function(raw) {
        cache = deserialize(raw)
        if (done) done(cache)
      }),
      fail: settle(function() {
        cache = []
        if (done) done(cache)
      })
    })
  } catch (error) {
    settle(function() {
      cache = []
      if (done) done(cache)
    })()
  }
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
export function enqueueAudio(uri, contentType, done, fail, requestId, bytes) {
  // PCM auto-stop returns bytes rather than a file URI. Never report that
  // recording as queued until it has been copied to the persistent files
  // partition; otherwise the UI promises a later send while keeping nothing.
  if (!uri && !bytes) {
    if (fail) fail(new Error("Запись не найдена на часах"))
    return
  }
  var fields = { kind: "audio", uri: uri || "", contentType: contentType || "", requestId: requestId || makeId() }
  if (bytes) {
    if (typeof file.writeArrayBuffer !== "function") {
      if (fail) fail(new Error("Рантайм не умеет сохранять запись на часах"))
      return
    }
    var byteSuffix = contentType === "audio/wav" ? ".wav" : contentType === "audio/opus" ? ".opus" : ".bin"
    var byteUri = "internal://files/timew/pending-" + makeId() + byteSuffix
    var write = guard(FILE_COPY_TIMEOUT_MS, function() {
      if (fail) fail(new Error("Не удалось сохранить запись на часах"))
    })
    function persistBytes() {
      try {
        file.writeArrayBuffer({
          uri: byteUri,
          buffer: bytes,
          success: write(function() {
            fields.uri = byteUri
            push(fields, done, fail)
          }),
          fail: write(function() {
            if (fail) fail(new Error("Не удалось сохранить запись на часах"))
          })
        })
      } catch (error) {
        write(function() { if (fail) fail(error) })()
      }
    }
    if (typeof file.mkdir === "function") {
      try {
        file.mkdir({ uri: "internal://files/timew", recursive: true, success: persistBytes, fail: persistBytes })
      } catch (error) {
        persistBytes()
      }
    } else {
      persistBytes()
    }
    return
  }
  // @system.record stores its result in internal://cache, which Vela may
  // purge under storage pressure. Copy it to the persistent files partition
  // before reporting that the offline item was saved. Unknown URI schemes or
  // older runtimes fall back to the original URI rather than losing the note.
  if (typeof file.copy !== "function" || String(uri).indexOf("internal://cache/") !== 0) {
    push(fields, done, fail)
    return
  }
  var suffix = contentType === "audio/wav" ? ".wav" : contentType === "audio/opus" ? ".opus" : ".bin"
  var durableUri = "internal://files/timew/pending-" + makeId() + suffix
  var settle = guard(FILE_COPY_TIMEOUT_MS, function() { push(fields, done, fail) })
  function copy() {
    try {
      file.copy({
        srcUri: uri,
        dstUri: durableUri,
        success: settle(function(result) {
          fields.uri = typeof result === "string" ? result : durableUri
          push(fields, done, fail)
        }),
        fail: settle(function() { push(fields, done, fail) })
      })
    } catch (error) {
      settle(function() { push(fields, done, fail) })()
    }
  }
  // The destination directory may not exist on a fresh install. mkdir is
  // best-effort: an existing directory reports failure on some firmware, and
  // copy itself is still the authoritative operation.
  if (typeof file.mkdir === "function") {
    try {
      file.mkdir({ uri: "internal://files/timew", recursive: true, success: copy, fail: copy })
    } catch (error) {
      copy()
    }
  } else {
    copy()
  }
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
    function cleanup(item, next) {
      if (item.kind !== "audio" || String(item.uri).indexOf("internal://files/") !== 0 || typeof file.delete !== "function") {
        next()
        return
      }
      var finish = guard(1500, next)
      try {
        file.delete({ uri: item.uri, success: finish(function() { next() }), fail: finish(function() { next() }) })
      } catch (error) {
        finish(function() { next() })()
      }
    }

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
        cleanup(item, next)
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
