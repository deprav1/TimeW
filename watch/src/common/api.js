import fetch from "@system.fetch"
import request from "@system.request"
import uploadtask from "@system.uploadtask"
import file from "@system.file"
import { getCached, rememberTransferMode, getRecordingSettings } from "./settings"
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

function requestTimeout() {
  return getRecordingSettings().requestTimeoutMs || REQUEST_TIMEOUT_MS
}

function uploadTimeout() {
  return getRecordingSettings().uploadTimeoutMs || UPLOAD_TIMEOUT_MS
}

// Последний голосовой запрос: сколько заняло целиком на часах и что шлюз
// сообщил о своих этапах. «Долго думает» без этих чисел неотличимо от
// «медленный провайдер», «медленная отправка» и «медленный канал».
var lastVoice = { at: 0, totalMs: 0, transport: "", bytes: 0, timings: null, requestId: "", error: "" }

export function lastVoiceStats() {
  return {
    at: lastVoice.at, totalMs: lastVoice.totalMs, transport: lastVoice.transport,
    bytes: lastVoice.bytes, timings: lastVoice.timings, requestId: lastVoice.requestId,
    error: lastVoice.error
  }
}

function beginVoice(transport, bytes) {
  lastVoice = { at: Date.now(), totalMs: 0, transport: transport, bytes: bytes || 0,
    timings: null, requestId: "", error: "" }
  return lastVoice.at
}

function endVoice(startedAt, response, error) {
  lastVoice.totalMs = Date.now() - startedAt
  if (response) {
    lastVoice.timings = response.timings || null
    lastVoice.requestId = response.requestId || ""
  }
  if (error) lastVoice.error = (error && error.message) || "ошибка"
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
  // Коды libcurl, а не HTTP: рантайм отдаёт их в том же поле.
  if (status === 6) return "Часы не нашли адрес шлюза — проверьте сеть"
  if (status === 35) return "Часы не доверяют сертификату шлюза"
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
    // Сообщение шлюза важнее нашего обобщённого: оно объясняет причину
    // (например, что не настроена озвучка), а по коду состояния этого не
    // видно — там просто «сервис недоступен».
    var serverMessage = body.error && body.error.message
    fail({
      message: serverMessage || messageForStatus(status) || "Сервер вернул ошибку",
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
// Коды рантайма совпадают с кодами libcurl: 6 — имя не разрешилось,
// 35 — не удалось договориться по TLS, 28 — истекло время. Из них
// повторять стоит только 6: DNS на часах отваливается пачками и так же
// пачками возвращается — в отчёте с устройства все семь запросов подряд
// упали за 110–341 мс с кодом 6, а отчёт, ушедший следом, прошёл.
//
// Повтор безопасен: каждый POST несёт Idempotency-Key, и шлюз отдаёт на
// повтор тот же ответ, а не заводит вторую заметку.
var DNS_FAILURE = 6
var RETRY_DELAY_MS = 700

function callFetch(options, timeoutMs, done, fail) {
  var retried = false
  var settle = guard(timeoutMs, function() {
    fail({ message: "Шлюз не ответил вовремя" })
  })

  function send() {
    options.success = settle(function(response) { handleResponse(response, done, fail) })
    options.fail = settle(function(error) {
      if (!retried && statusFrom(error) === DNS_FAILURE) {
        retried = true
        // Сторож ещё идёт: вторая попытка живёт в том же окне ожидания,
        // и человек видит не ошибку, а чуть более долгий ответ.
        if (settle.cancel) settle.cancel()
        settle = guard(timeoutMs, function() {
          fail({ message: "Шлюз не ответил вовремя" })
        })
        setTimeout(send, RETRY_DELAY_MS)
        return
      }
      handleFail(error, fail)
    })
    try {
      fetch.fetch(options)
    } catch (error) {
      settle(function() { fail({ message: "Не удалось начать запрос к шлюзу" }) })()
    }
  }

  send()
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

export function status(done, fail) {
  callFetch({
    url: baseUrl() + "/api/v1/status",
    method: "GET",
    header: headers()
  }, requestTimeout(), done, fail)
}

export function query(text, done, fail, requestKey) {
  var payload = { text: text }
  var stableKey = requestKey || makeRequestKey("query")
  payload.requestId = stableKey
  var provider = getCached().aiProvider
  if (provider && provider !== "auto") payload.provider = provider
  callFetch({
    url: baseUrl() + "/api/v1/query" + (getCached().speakAnswers ? "?speak=1" : ""),
    method: "POST",
    header: headers({ "Idempotency-Key": stableKey }),
    data: JSON.stringify(payload)
  }, requestTimeout(), done, fail)
}

export function listNotes(done, fail) {
  callFetch({
    url: baseUrl() + "/api/v1/notes",
    method: "GET",
    header: headers()
  }, requestTimeout(), done, fail)
}

export function deleteNote(id, done, fail) {
  callFetch({
    url: baseUrl() + "/api/v1/notes/" + id,
    method: "DELETE",
    header: headers()
  }, requestTimeout(), done, fail)
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
  // «Я буду слушать»: шлюз начнёт синтез вместе с ответом, и к моменту, когда
  // часы попросят озвучку, она уже готова. Это те самые три секунды тишины
  // между ответом на экране и голосом.
  if (getCached().speakAnswers) params.push("speak=1")
  return params.length ? path + "?" + params.join("&") : path
}

// Путь A: request.upload отправляет файл по uri как multipart/form-data.
// Шлюз принимает multipart наравне с сырым телом.
function uploadByUri(path, uri, contentType, intent, requestKey, preview, recordedMs, done, fail) {
  // Проверено опросом рантайма: метода request.upload не существует.
  // Вызов несуществующей функции бросает исключение, поэтому проверяем явно,
  // а не полагаемся на колбэк ошибки. Путь оставлен на случай прошивки,
  // где он появится.
  if (!request || typeof request.upload !== "function") {
    fail({ message: "Отправка файлом не поддерживается" })
    return
  }
  var uploadHeaders = { "Idempotency-Key": requestKey }
  if (recordedMs) uploadHeaders["X-TimeW-Record-Ms"] = String(Math.round(recordedMs))
  var token = deviceToken()
  if (token) uploadHeaders["X-TimeW-Device-Token"] = token
  var settle = guard(uploadTimeout(), function() {
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

// Официальный multipart-путь Vela. Он оставлен opt-in до физического зонда:
// в отличие от request.upload он не был проверен на этой конкретной S5.
// Если runtime-профиль вручную выберет uploadtask, файл не читается целиком
// в JS-память, а таймаут/abort возвращают управление как любой другой system-call.
function uploadByTask(path, uri, contentType, intent, requestKey, preview, recordedMs, done, fail) {
  if (!uploadtask || typeof uploadtask.uploadFile !== "function") {
    fail({ message: "uploadtask не поддерживается этой прошивкой" })
    return
  }
  var uploadHeaders = { "Idempotency-Key": requestKey }
  if (recordedMs) uploadHeaders["X-TimeW-Record-Ms"] = String(Math.round(recordedMs))
  var token = deviceToken()
  if (token) uploadHeaders["X-TimeW-Device-Token"] = token
  var task
  var settle = guard(uploadTimeout(), function() {
    if (task && typeof task.abort === "function") {
      try { task.abort() } catch (error) {}
    }
    fail({ message: "Отправка записи не ответила" })
  })
  try {
    task = uploadtask.uploadFile({
      url: baseUrl() + withProvider(path, intent, preview),
      filePath: uri,
      name: "audio",
      header: uploadHeaders,
      formData: { filename: filenameFor(contentType), contentType: contentType || "application/octet-stream" },
      timeout: uploadTimeout(),
      success: settle(function(response) {
        handleResponse(response, done, fail)
      }),
      fail: settle(function(error, code) {
        fail({
          message: (typeof error === "string" ? error : error && error.message) || "Не удалось отправить запись",
          code: code
        })
      })
    })
  } catch (error) {
    settle(function() { fail({ message: "Не удалось начать uploadtask" }) })()
  }
}

// Путь B: прочитать файл в память и отправить сырые байты.
function uploadByBytes(path, uri, contentType, intent, requestKey, preview, recordedMs, done, fail) {
  var settle = guard(requestTimeout(), function() {
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
      sendAudioBytes(path, bytes, contentType, intent, requestKey, preview, recordedMs, done, fail)
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

var BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

// Своя кодировка: btoa в рантайме Vela не гарантирован, а принимать на веру
// после истории с request.upload и prompt.show не стоит.
function toBase64(buffer) {
  var bytes = new Uint8Array(buffer)
  var out = ""
  var i = 0
  for (; i + 2 < bytes.length; i += 3) {
    var n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]
    out += BASE64_ALPHABET.charAt((n >> 18) & 63) + BASE64_ALPHABET.charAt((n >> 12) & 63) +
           BASE64_ALPHABET.charAt((n >> 6) & 63) + BASE64_ALPHABET.charAt(n & 63)
  }
  var left = bytes.length - i
  if (left === 1) {
    var a = bytes[i] << 16
    out += BASE64_ALPHABET.charAt((a >> 18) & 63) + BASE64_ALPHABET.charAt((a >> 12) & 63) + "=="
  } else if (left === 2) {
    var b = (bytes[i] << 16) | (bytes[i + 1] << 8)
    out += BASE64_ALPHABET.charAt((b >> 18) & 63) + BASE64_ALPHABET.charAt((b >> 12) & 63) +
           BASE64_ALPHABET.charAt((b >> 6) & 63) + "="
  }
  return out
}

// Запись уходит текстом внутри JSON, а не двоичным телом.
//
// Проверено на устройстве: рантайм Vela двоичное тело не отправляет. В теле
// запроса на шлюзе оказался обрывок текста HTTP-запроса («POST /api/v1…»),
// а тип содержимого рантайм дополнил charset=utf-8 — то есть счёл тело
// текстом и подставил что-то своё. Текстовые запросы с часов работают
// надёжно, поэтому запись едет как base64: плюс треть объёма, зато доезжает.
function sendAudioBytes(path, audio, contentType, intent, requestKey, preview, recordedMs, done, fail) {
  var encoded
  try {
    encoded = toBase64(audio)
  } catch (error) {
    fail({ message: "Не удалось подготовить запись к отправке" })
    return
  }
  var extra = { "Idempotency-Key": requestKey }
  if (recordedMs) extra["X-TimeW-Record-Ms"] = String(Math.round(recordedMs))
  var payload = JSON.stringify({
    audioBase64: encoded,
    contentType: contentType || "application/octet-stream"
  })
  // Строка base64 уже скопирована в тело запроса, а весит столько же,
  // сколько сама запись. Отпускаем её здесь, не дожидаясь ответа шлюза:
  // документация Vela советует runGC ровно после таких операций, а часы у
  // нас зависают именно на пиках памяти.
  encoded = null
  try {
    if (typeof global !== "undefined" && global && typeof global.runGC === "function") global.runGC()
  } catch (error) {
    // Подсказка сборщику, не обязательный шаг.
  }
  callFetch({
    url: baseUrl() + withProvider(path, intent, preview),
    method: "POST",
    header: headers(extra),
    data: payload
  }, uploadTimeout(), done, fail)
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
export function voiceBytes(bytes, contentType, intent, done, fail, options) {
  var requestKey = (options && options.requestKey) || makeRequestKey("voice")
  var preview = !options || options.preview !== false
  var size = bytes && (bytes.byteLength || bytes.length) || 0
  var startedAt = beginVoice("bytes", size)
  sendAudioBytes("/api/v1/voice", bytes, contentType, intent, requestKey, preview, options && options.recordedMs,
    function(response) { endVoice(startedAt, response, null); done(response) },
    function(error) { endVoice(startedAt, null, error); fail(error) })
}

export function voiceUri(uri, contentType, intent, done, fail, options) {
  var senders = {
    upload: uploadByUri,
    uploadtask: uploadByTask,
    bytes: uploadByBytes
  }
  var requestKey = (options && options.requestKey) || makeRequestKey("voice")
  var preview = !options || options.preview !== false
  var startedAt = beginVoice("uri", 0)

  // Способы доставки записи, доступные на этой прошивке. request.upload на
  // Watch S5 отсутствует (проверено опросом рантайма), и раньше он всё равно
  // числился запасным путём — поэтому при любой неудаче человек видел
  // «Отправка файлом не поддерживается» вместо настоящей причины.
  var available = ["bytes"]
  if (request && typeof request.upload === "function") available.push("upload")
  var cachedMode = getCached().transferMode
  if (cachedMode === "uploadtask" && uploadtask && typeof uploadtask.uploadFile === "function") available.push("uploadtask")
  var preferred = cachedMode === "upload" && available.indexOf("upload") >= 0 ? "upload" :
    (cachedMode === "uploadtask" && available.indexOf("uploadtask") >= 0 ? "uploadtask" : "bytes")
  var order = [preferred].concat(available.filter(function(mode) { return mode !== preferred }))

  function attempt(index, firstError) {
    if (index >= order.length) {
      // Сообщаем ошибку первой попытки: она о сути дела, а не о том, что
      // запасной путь тоже не сработал.
      fail(firstError || { message: "Не удалось отправить запись" })
      return
    }
    var mode = order[index]
    senders[mode]("/api/v1/voice", uri, contentType, intent, requestKey, preview, options && options.recordedMs, function(response) {
      rememberTransferMode(mode)
      lastVoice.transport = mode
      endVoice(startedAt, response, null)
      done(response, mode)
    }, function(error) {
      endVoice(startedAt, null, error)
      // Preserve the idempotency key across an offline defer. If the gateway
      // committed the note but the response was lost, retrying with a new key
      // would create a duplicate note.
      if (error && !error.requestKey) error.requestKey = requestKey
      // Отказ шлюза и пропавший файл повторять нечем: второй способ доставки
      // получит тот же ответ, а человек лишний раз подождёт таймаут.
      if (error && (error.serverError || error.gone)) {
        fail(error)
        return
      }
      attempt(index + 1, firstError || error)
    })
  }

  // Сначала — способ, сработавший в прошлый раз: молчащий путь стоит целого
  // таймаута, а на голосовой команде это заметные секунды ожидания.
  attempt(0, null)
}

export function resetDialog(done, fail) {
  callFetch({
    url: baseUrl() + "/api/v1/dialog/reset",
    method: "POST",
    header: headers(),
    data: "{}"
  }, requestTimeout(), done, fail)
}

export function confirmHome(confirmationToken, done, fail) {
  callFetch({
    url: baseUrl() + "/api/v1/home/confirm",
    method: "POST",
    header: headers({ "Idempotency-Key": makeRequestKey("home-confirm") }),
    data: JSON.stringify({ confirmationToken: confirmationToken })
  }, requestTimeout(), done, fail)
}

export function undoHome(undoToken, done, fail) {
  var key = makeRequestKey("home-undo")
  callFetch({
    url: baseUrl() + "/api/v1/home/undo",
    method: "POST",
    header: headers({ "Idempotency-Key": key }),
    data: JSON.stringify({ undoToken: undoToken, requestId: key })
  }, requestTimeout(), done, fail)
}

// Отчёт диагностики уходит на шлюз и попадает в его лог. Это единственный
// способ увидеть состояние часов удалённо: экран оттуда не виден, а логи
// рантайма Vela достаются только через телефон.
export function sendDiagnostics(report, done, fail) {
  callFetch({
    url: baseUrl() + "/api/v1/diag",
    method: "POST",
    header: headers(),
    data: JSON.stringify(report)
  }, requestTimeout(), done, fail)
}
