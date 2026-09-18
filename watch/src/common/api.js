import fetch from "@system.fetch"
import request from "@system.request"
import file from "@system.file"
import { getCached, rememberTransferMode } from "./settings"
import { guard } from "./guard"
import { REQUEST_TIMEOUT_MS, UPLOAD_TIMEOUT_MS } from "./config"

function baseUrl() {
  var settings = getCached()
  var url = settings.gatewayUrl || ""
  if (url.length > 0 && url.charAt(url.length - 1) === "/") {
    return url.substring(0, url.length - 1)
  }
  return url
}

function deviceToken() {
  return getCached().deviceToken
}

var requestCounter = 0
function makeRequestKey(kind) {
  requestCounter += 1
  return "timew-" + kind + "-" + Date.now() + "-" + requestCounter
}

function parse(response) {
  var raw = response && (response.data || response.body || response)
  return typeof raw === "string" ? JSON.parse(raw) : raw
}

function headers(extra) {
  var result = { "Content-Type": "application/json" }
  var token = deviceToken()
  if (token) result["X-TimeW-Device-Token"] = token
  if (extra) {
    Object.keys(extra).forEach(function(key) { result[key] = extra[key] })
  }
  return result
}

function statusFrom(response) {
  if (!response) return 0
  if (typeof response.code === "number") return response.code
  if (typeof response.statusCode === "number") return response.statusCode
  return 0
}

function messageForStatus(status) {
  if (status === 401) return "Неверный токен устройства. Проверьте настройки"
  if (status === 429) return "Слишком много запросов, подождите немного"
  if (status === 502 || status === 503 || status === 504) return "AI сейчас недоступен, попробуйте позже"
  if (status === 413) return "Запись слишком длинная"
  return ""
}

// Handles a raw @system.fetch success callback: parses the body, checks the
// ok flag from the server contract, and maps HTTP/server error codes to a
// human-readable Russian message. Calls done(parsedBody) on real success or
// fail(errorObject) otherwise. Used by every endpoint so behavior is uniform.
function handleResponse(response, done, fail) {
  var status = statusFrom(response)
  var body
  try {
    body = parse(response)
  } catch (parseError) {
    fail({ message: messageForStatus(status) || "Не удалось разобрать ответ шлюза" })
    return
  }

  // serverError означает «шлюз ответил, и ответ — отказ». Менять транспорт
  // в этом случае бессмысленно: вторая попытка получит тот же отказ, а
  // пользователь лишний раз прождёт таймаут.
  if (body && body.ok === false) {
    var serverMessage = body.error && body.error.message
    fail({
      message: messageForStatus(status) || serverMessage || "Сервер вернул ошибку",
      code: body.error && body.error.code,
      serverError: true
    })
    return
  }

  if (status && status >= 400) {
    fail({ message: messageForStatus(status) || "Не удалось связаться со шлюзом", serverError: true })
    return
  }

  try {
    done(body)
  } catch (handlerError) {
    fail(handlerError)
  }
}

// Единая обёртка вызова @system.fetch со сторожевым таймером: если модуль
// промолчит, запрос завершится понятной ошибкой, а не вечным ожиданием.
function callFetch(options, timeoutMs, done, fail) {
  var settle = guard(timeoutMs, function() {
    fail({ message: "Шлюз не ответил вовремя" })
  })
  options.success = settle(function(response) { handleResponse(response, done, fail) })
  options.fail = settle(function(error) { handleFail(error, fail) })
  try {
    fetch.fetch(options)
  } catch (error) {
    settle(function() { fail({ message: "Не удалось начать запрос к шлюзу" }) })()
  }
}

function handleFail(error, fail) {
  var status = statusFrom(error)
  var mapped = messageForStatus(status)
  if (mapped) {
    fail({ message: mapped })
    return
  }
  fail(error)
}

export function query(text, done, fail, requestKey) {
  var payload = { text: text }
  var stableKey = requestKey || makeRequestKey("query")
  payload.requestId = stableKey
  var provider = getCached().aiProvider
  if (provider && provider !== "auto") payload.provider = provider
  callFetch({
    url: baseUrl() + "/api/v1/query",
    method: "POST",
    header: headers({ "Idempotency-Key": stableKey }),
    data: JSON.stringify(payload)
  }, REQUEST_TIMEOUT_MS, done, fail)
}

export function listNotes(done, fail) {
  callFetch({
    url: baseUrl() + "/api/v1/notes",
    method: "GET",
    header: headers()
  }, REQUEST_TIMEOUT_MS, done, fail)
}

export function deleteNote(id, done, fail) {
  callFetch({
    url: baseUrl() + "/api/v1/notes/" + id,
    method: "DELETE",
    header: headers()
  }, REQUEST_TIMEOUT_MS, done, fail)
}

function filenameFor(contentType) {
  if (contentType === "audio/opus") return "record.opus"
  if (contentType === "audio/wav") return "record.wav"
  return "record.bin"
}

// @system.record отдаёт путь к файлу, а не байты, и документация Xiaomi не
// описывает, как этот файл доставить на сервер. Поэтому реализованы два пути,
// и при неудаче первого автоматически пробуется второй — чтобы первая же
// проверка на реальных часах дала результат, а не упёрлась в выбор способа.
//
// Провайдер передаётся в query-строке: у multipart-пути нет удобного места
// для поля, а "auto" означает «как настроено на шлюзе».
// preview=1 означает «распознай, но не сохраняй»: человек сначала видит
// текст и подтверждает. Для отложенной заметки из офлайн-очереди это не
// годится — она уходит позже, когда никто не смотрит на экран, поэтому там
// preview выключается и заметка сохраняется сразу.
function withProvider(path, intent, preview) {
  var params = []
  var provider = getCached().aiProvider
  if (provider && provider !== "auto") params.push("provider=" + provider)
  if (intent) params.push("intent=" + intent)
  if (intent === "note" && preview) params.push("preview=1")
  return params.length ? path + "?" + params.join("&") : path
}

// Путь A: request.upload отправляет файл по uri как multipart/form-data.
// Шлюз принимает multipart наравне с сырым телом.
function uploadByUri(path, uri, contentType, intent, requestKey, preview, done, fail) {
  // Проверено опросом рантайма: метода request.upload не существует.
  // Вызов несуществующей функции бросает исключение, поэтому проверяем явно,
  // а не полагаемся на колбэк ошибки. Путь оставлен на случай прошивки,
  // где он появится.
  if (!request || typeof request.upload !== "function") {
    fail({ message: "Отправка файлом не поддерживается" })
    return
  }
  var uploadHeaders = { "Idempotency-Key": requestKey }
  var token = deviceToken()
  if (token) uploadHeaders["X-TimeW-Device-Token"] = token
  var settle = guard(UPLOAD_TIMEOUT_MS, function() {
    fail({ message: "Отправка записи не ответила" })
  })
  request.upload({
    url: baseUrl() + withProvider(path, intent, preview),
    method: "POST",
    header: uploadHeaders,
    files: [{
      uri: uri,
      name: "audio",
      filename: filenameFor(contentType),
      type: contentType || "application/octet-stream"
    }],
    success: settle(function(response) { handleResponse(response, done, fail) }),
    fail: settle(function(error) { handleFail(error, fail) })
  })
}

// Путь B: прочитать файл в память и отправить сырые байты.
function uploadByBytes(path, uri, contentType, intent, requestKey, preview, done, fail) {
  var settle = guard(REQUEST_TIMEOUT_MS, function() {
    fail({ message: "Не удалось прочитать запись с часов" })
  })
  file.readArrayBuffer({
    uri: uri,
    success: settle(function(data) {
      var bytes = data && (data.buffer || data)
      var size = bytes ? (bytes.byteLength || bytes.length || 0) : 0
      if (!bytes) {
        // Файл записи пропал — из кэша приложения его мог убрать рантайм.
        // Для отложенной заметки это окончательный приговор: повторять
        // нечего, поэтому помечаем ошибку как неустранимую.
        fail({ message: "Запись не найдена на часах", gone: true })
        return
      }
      // Пустой файл отправлять бессмысленно: шлюз вернёт 400, а человек
      // увидит техническую ошибку вместо понятного «ничего не расслышали».
      if (size === 0) {
        fail({ message: "Ничего не записалось, попробуйте ещё раз", serverError: true })
        return
      }
      sendAudioBytes(path, bytes, contentType, intent, requestKey, preview, done, fail)
    }),
    // Файл не прочитался — это не обрыв связи, а потеря записи: рантайм
    // вправе чистить кэш приложения. Повторять нечего, поэтому помечаем
    // gone, иначе отложенная заметка будет вечно стоять первой в очереди
    // и загораживать всё, что за ней.
    fail: settle(function() {
      fail({ message: "Запись не найдена на часах", gone: true })
    })
  })
}

function sendAudioBytes(path, audio, contentType, intent, requestKey, preview, done, fail) {
  var requestHeaders = headers({ "Content-Type": contentType || "application/octet-stream", "Idempotency-Key": requestKey })
  callFetch({
    url: baseUrl() + withProvider(path, intent, preview),
    method: "POST",
    header: requestHeaders,
    data: audio
  }, UPLOAD_TIMEOUT_MS, done, fail)
}

// Один запрос вместо двух: шлюз распознаёт речь и сразу отвечает.
// На часах Wi-Fi поднимается по требованию, поэтому лишний круг стоит секунд.
// done получает вторым аргументом имя сработавшего пути доставки файла
// ("upload" | "bytes") — нужно для проверки на реальных часах.
// options.preview === false — отправить заметку сразу, без промежуточного
// подтверждения (досылка из офлайн-очереди).
// options.requestKey — свой ключ идемпотентности: у отложенной записи он
// сохраняется вместе с ней, поэтому повторная досылка после сбоя связи не
// создаёт вторую заметку.
export function voiceUri(uri, contentType, intent, done, fail, options) {
  var senders = {
    upload: uploadByUri,
    bytes: uploadByBytes
  }
  var preferred = getCached().transferMode === "upload" ? "upload" : "bytes"
  var other = preferred === "upload" ? "bytes" : "upload"
  var requestKey = (options && options.requestKey) || makeRequestKey("voice")
  var preview = !options || options.preview !== false

  function attempt(mode, onFail) {
    senders[mode]("/api/v1/voice", uri, contentType, intent, requestKey, preview, function(response) {
      rememberTransferMode(mode)
      done(response, mode)
    }, onFail)
  }

  // Сначала — способ, сработавший в прошлый раз: молчащий путь стоит целого
  // таймаута, а на голосовой команде это заметные секунды ожидания.
  attempt(preferred, function(error) {
    // gone — файла записи больше нет; второй способ доставки его не воскресит.
    if (error && (error.serverError || error.gone)) {
      fail(error)
      return
    }
    attempt(other, fail)
  })
}

export function resetDialog(done, fail) {
  callFetch({
    url: baseUrl() + "/api/v1/dialog/reset",
    method: "POST",
    header: headers(),
    data: "{}"
  }, REQUEST_TIMEOUT_MS, done, fail)
}

export function confirmHome(confirmationToken, done, fail) {
  callFetch({
    url: baseUrl() + "/api/v1/home/confirm",
    method: "POST",
    header: headers({ "Idempotency-Key": makeRequestKey("home-confirm") }),
    data: JSON.stringify({ confirmationToken: confirmationToken })
  }, REQUEST_TIMEOUT_MS, done, fail)
}
