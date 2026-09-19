import request from "@system.request"
import fetch from "@system.fetch"
import file from "@system.file"
import audio from "@system.audio"
import volume from "@system.volume"
import { getCached, getRecordingSettings } from "./settings"
import { guard } from "./guard"
import { UPLOAD_TIMEOUT_MS } from "./config"

// Озвучка ответа.
//
// В Vela нет модуля синтеза речи, а @system.audio умеет проигрывать только
// ссылку — он не принимает байты и не делает POST с заголовками. Тащить текст
// ответа в URL нельзя (длинные ответы, кириллица), токен в URL — тем более
// (утечёт в логи туннеля и прокси).
//
// Поэтому шлюз вместе с ответом отдаёт короткоживущий speechId, а часы
// скачивают аудио отдельным запросом: request.download заголовки поддерживает,
// в отличие от audio.src. Проигрывается уже локальный файл.

function baseUrl() {
  var url = getCached().gatewayUrl || ""
  if (url.length > 0 && url.charAt(url.length - 1) === "/") {
    return url.substring(0, url.length - 1)
  }
  return url
}

function messageForStatus(status) {
  if (status === 401) return "Неверный токен устройства. Проверьте настройки"
  if (status === 404) return "Озвучка устарела, спросите заново"
  if (status === 503) return "Синтез речи не настроен на шлюзе"
  if (status === 202) return "Рантайм отклонил параметры загрузки озвучки"
  if (status === 35) return "Часы не доверяют TLS-сертификату шлюза"
  if (status === 1000) return "Загрузка озвучки не удалась"
  if (status === 1001) return "Задача загрузки озвучки исчезла"
  if (status === 204) return "Шлюз не ответил вовремя"
  return "Не удалось получить озвучку"
}

var activeFinish = null
var lastPlayback = { started: false, error: "", volume: -1 }
var speechReport = {
  transport: "request.download", headerShape: "string-json", tokenPresent: false,
  phase: "idle", code: null, attempts: 0, fallback: "",
  // Куда ушло время внутри озвучки: запрос к шлюзу, разбор base64, запись
  // файла. Без разбивки «медленно» неотличимо от «медленный провайдер».
  timings: { fetchMs: 0, decodeMs: 0, writeMs: 0, bytes: 0 }
}

// Какой транспорт довёз звук в прошлый раз. Молчащий путь стоит целого окна
// ожидания, а на озвучке ответа это пятнадцать секунд тишины перед звуком.
// Флаг модульный, не в хранилище: цена ошибки — одна лишняя попытка за
// запуск, а новый ключ настроек стоит правок в пяти местах.
var downloadUnusable = false

// Номер попытки озвучки. Опрос загрузки живёт таймерами, и колбэк прошлой
// попытки приходит уже во время следующей: он правил бы её отчёт и мог бы
// проиграть чужой файл. Поэтому у каждой попытки свой номер, а всё, что
// пришло не от текущей, — no-op.
var speechEpoch = 0

function currentEpoch(epoch) {
  return epoch === speechEpoch
}

// Номер берётся в самом начале — до чтения громкости. Иначе так: человек
// нажал «Слушать», сторож громкости отработал через секунду, а озвучку уже
// отменили — и отменённая попытка всё равно уходила качать файл.
function beginSpeech() {
  speechEpoch += 1
  return speechEpoch
}

function downloadRequest() {
  var headers = {}
  var token = getCached().deviceToken
  if (token) headers["X-TimeW-Device-Token"] = token
  return {
    value: Object.keys(headers).length ? JSON.stringify(headers) : "",
    tokenPresent: !!token
  }
}

// Когда рантайм не дал кода — а он не даёт его при исключении и при
// сторожевом таймере, — сообщение называет этап. «Не удалось получить
// озвучку» одинаково звучит и для отказа сети, и для пропавшего файла.
function messageForPhase(phase) {
  if (phase === "start-failed") return "Не удалось начать загрузку озвучки"
  if (phase === "download-failed") return "Не удалось получить файл озвучки"
  if (phase === "waiting-file") return "Не удалось получить файл озвучки"
  if (phase === "no-token") return "Шлюз не отдал озвучку"
  if (phase === "timeout") return "Озвучка не пришла вовремя"
  if (phase === "fallback-timeout") return "Озвучка не пришла вовремя"
  if (phase === "fallback-too-big") return "Ответ слишком длинный для озвучки"
  if (phase === "fallback-failed") return "Не удалось получить озвучку"
  return ""
}

function freshReport(transport, headerShape, phase, tokenPresent) {
  return {
    transport: transport, headerShape: headerShape, tokenPresent: !!tokenPresent,
    phase: phase, code: null, attempts: 0, fallback: "",
    timings: { fetchMs: 0, decodeMs: 0, writeMs: 0, bytes: 0 }
  }
}

function speechFailure(code, phase, extra) {
  speechReport.phase = phase
  // Код первой осмысленной причины не затирается более поздним отказом без
  // кода: в отчёте нужен именно он — по нему видно, на чём споткнулась
  // файловая загрузка, даже когда дальше отработал запасной путь.
  if (typeof code === "number") speechReport.code = code
  var text = (typeof code === "number" ? messageForStatus(code) : "") ||
    messageForPhase(phase) || messageForStatus(code)
  var result = { message: text, code: code || null, phase: phase,
    transport: "request.download", headerShape: "string-json",
    tokenPresent: speechReport.tokenPresent, attempts: speechReport.attempts,
    fallback: speechReport.fallback }
  if (extra) Object.keys(extra).forEach(function(key) { result[key] = extra[key] })
  return result
}

// Пока воспроизведение не началось, ждём недолго: рантайм, не принявший файл,
// может не прислать ни ended, ни error — и экран остался бы в состоянии «Стоп»
// навсегда. После старта сторож растягивается, потому что длинный ответ
// проигрывается минуты.
var PLAY_START_TIMEOUT_MS = 8000
var PLAY_MAX_MS = 180000

function play(uri, done, fail) {
  var settled = false
  var started = false
  var timer = 0

  function arm(ms, onTimeout) {
    if (timer) clearTimeout(timer)
    timer = setTimeout(function() { timer = 0; onTimeout() }, ms)
    // В Vela setTimeout возвращает число и unref нет — проверка безвредна.
    // В Node долгий сторож иначе держал бы процесс тестов открытым.
    if (timer && typeof timer.unref === "function") timer.unref()
  }

  function detach() {
    if (timer) { clearTimeout(timer); timer = 0 }
    audio.onended = null
    audio.onstop = null
    audio.onerror = null
    audio.onplay = null
    audio.onloadeddata = null
    // Освобождаем аудиосессию явно. Естественный конец файла её не отпускает:
    // после проигранного ответа record.start отвечал кодом 202 — «неверные
    // параметры», хотя параметры были те же, что и в работавшей записи.
    // Снаружи это выглядело так: первый ответ слышно, дальше ничего не
    // работает.
    try { if (typeof audio.stop === "function") audio.stop() } catch (error) {}
  }

  function finishOk() {
    if (settled) return
    settled = true
    if (activeFinish === finishOk) activeFinish = null
    detach()
    if (done) done()
  }
  function finishError(error) {
    if (settled) return
    settled = true
    if (activeFinish === finishOk) activeFinish = null
    detach()
    lastPlayback.error = (error && error.message) || "ошибка"
    if (fail) fail(error || { message: "Часы не смогли проиграть ответ" })
  }

  function markStarted() {
    if (started) return
    started = true
    lastPlayback.started = true
    arm(PLAY_MAX_MS, finishOk)
  }

  activeFinish = finishOk
  lastPlayback = { started: false, error: "", volume: lastPlayback.volume }
  try {
    audio.onended = finishOk
    // A stop is terminal for the UI too: the user explicitly asked to stop.
    audio.onstop = finishOk
    audio.onerror = function() { finishError({ message: "Часы не смогли проиграть ответ" }) }
    // Оба события означают «файл принят»: дальше ждать нечего, кроме конца.
    audio.onplay = markStarted
    audio.onloadeddata = markStarted
    audio.src = uri
    if (typeof audio.play !== "function") throw new Error("audio.play is unavailable")
    arm(PLAY_START_TIMEOUT_MS, function() {
      finishError({ message: "Часы не проиграли ответ" })
    })
    audio.play()
  } catch (error) {
    finishError({ message: "Часы не смогли проиграть ответ" })
  }
}

// Громкость мультимедиа — системная настройка человека, менять её приложение
// не должно. Но прочитать стоит: при нуле озвучка отработает штатно и молча,
// и без этой проверки причина выглядит как «озвучка не работает».
export function mediaVolume(done) {
  var settle = guard(1000, function() { done(-1) })
  try {
    if (!volume || typeof volume.getMediaValue !== "function") {
      settle(function() { done(-1) })()
      return
    }
    volume.getMediaValue({
      success: settle(function(data) {
        var value = data && typeof data.value === "number" ? data.value : -1
        lastPlayback.volume = value
        done(value)
      }),
      fail: settle(function() { done(-1) })
    })
  } catch (error) {
    settle(function() { done(-1) })()
  }
}

export function lastPlaybackReport() {
  return { started: lastPlayback.started, error: lastPlayback.error, volume: lastPlayback.volume }
}

export function lastSpeechReport() {
  return {
    transport: speechReport.transport, headerShape: speechReport.headerShape,
    tokenPresent: speechReport.tokenPresent, phase: speechReport.phase,
    code: speechReport.code, attempts: speechReport.attempts,
    fallback: speechReport.fallback,
    timings: {
      fetchMs: speechReport.timings.fetchMs, decodeMs: speechReport.timings.decodeMs,
      writeMs: speechReport.timings.writeMs, bytes: speechReport.timings.bytes
    }
  }
}

function speechUrl(speechId) {
  // The gateway owns the actual MIME type; this is only a format hint so a
  // deployment can choose its configured codec without changing the watch.
  // Playback still uses the downloaded file returned by the runtime.
  var configured = getRecordingSettings().ttsFormat === "mp3" ? "mp3" : "wav"
  return baseUrl() + "/api/v1/speak/" + encodeURIComponent(speechId) + "?format=" + configured
}

export function speak(speechId, done, fail) {
  if (!speechId) {
    fail({ message: "Нечего озвучивать" })
    return
  }
  var epoch = beginSpeech()
  // Отчёт описывает последнюю попытку, а не какую-нибудь из прошлых: без
  // сброса диагностика показывала бы успех предыдущей озвучки как текущий.
  lastPlayback = { started: false, error: "", volume: -1 }
  // Ноль громкости даёт ровно то же наблюдаемое поведение, что и сломанная
  // озвучка: тишина. Разница в одну строку на экране экономит час поисков.
  mediaVolume(function(value) {
    if (!currentEpoch(epoch)) return
    if (value >= 0 && value < 0.05) {
      fail({ message: "Звук на часах выключен" })
      return
    }
    download(speechId, done, fail)
  })
}

// onDownloadComplete спрашивает состояние задачи, а не ждёт её конца. Пока
// шлюз синтезирует фразу — а это около трёх секунд, — задача не готова, и
// единственный вызов возвращал отказ 1000: озвучка «не работала», хотя файл
// приезжал секундой позже. Поэтому спрашиваем повторно.
//
// Окно опроса короче общего сторожа намеренно: если дело не в ожидании, а в
// самой загрузке, человек не должен стоять перед экраном минуту, чтобы
// услышать «не получилось». Число попыток уходит в отчёт — по нему видно,
// ждали мы или упёрлись в отказ с первой же секунды.
var POLL_INTERVAL_MS = 700
var POLL_WINDOW_MS = 15000
var POLL_MAX_ATTEMPTS = 24

function awaitDownloaded(token, onUri, onFail) {
  var epoch = speechEpoch
  var deadline = Date.now() + POLL_WINDOW_MS
  var attempts = 0
  function ask() {
    // Опрос прошлой попытки просто прекращается: файл, который он ждёт,
    // больше никому не нужен.
    if (!currentEpoch(epoch)) return
    attempts += 1
    speechReport.attempts = attempts
    var spent = Date.now() >= deadline || attempts >= POLL_MAX_ATTEMPTS
    try {
      request.onDownloadComplete({
        token: token,
        success: function(result) {
          var uri = result && (result.uri || result)
          if (uri) {
            onUri(uri)
            return
          }
          if (spent) {
            onFail(null)
            return
          }
          setTimeout(ask, POLL_INTERVAL_MS)
        },
        fail: function(error, code) {
          // 1001 — задачи больше нет: повторять нечего, файл не появится.
          if (code === 1001 || spent) {
            onFail(code)
            return
          }
          setTimeout(ask, POLL_INTERVAL_MS)
        }
      })
    } catch (error) {
      onFail(null)
    }
  }
  ask()
}

// Общий путь для озвучки ответа и для проверки динамика: отличаются они
// только адресом и тем, что делать с готовым файлом.
function fetchAudio(url, onUri, onFail) {
  // Файловая загрузка на Watch S5 мертва: два отчёта подряд, тринадцать и
  // четырнадцать опросов, каждый раз код 1000. Пятнадцать секунд ожидания
  // перед каждой озвучкой — это и были те 35 секунд, за которые «звук
  // появился, но медленно». Поэтому по умолчанию сразу текстовый транспорт,
  // а файловый включается только явным speechTransport:"download" со шлюза —
  // на случай прошивки, где он работает.
  if (getRecordingSettings().speechTransport !== "download") {
    speechReport = freshReport("fetch-base64", "object", "bytes-first", !!getCached().deviceToken)
    fetchAudioBytes(url, onUri, onFail)
    return
  }
  // Путь, отказавший в этой сессии, второй раз не пробуем: он стоит целого
  // окна ожидания, а человек слышит тишину всё это время.
  if (downloadUnusable) {
    speechReport = freshReport("fetch-base64", "object", "fallback", !!getCached().deviceToken)
    fetchAudioBytes(url, onUri, onFail)
    return
  }
  downloadThenBytes(url, onUri, onFail)
}

function downloadThenBytes(url, onUri, onFail) {
  var epoch = speechEpoch
  var requestHeader = downloadRequest()
  speechReport = freshReport("request.download", "string-json", "start", requestHeader.tokenPresent)

  // Любой отказ файловой загрузки — повод попробовать текстовый транспорт,
  // а не сообщать человеку тишину.
  function orBytes(failure) {
    if (!currentEpoch(epoch)) return
    downloadUnusable = true
    speechReport.phase = failure && failure.phase ? failure.phase : "download-failed"
    fetchAudioBytes(url, onUri, function(fallbackFailure) {
      // Наверх уходит причина отказа запасного пути: первая уже описана в
      // отчёте полями phase и code, а человеку нужна последняя.
      onFail(fallbackFailure)
    })
  }

  var settle = guard(UPLOAD_TIMEOUT_MS, function() {
    orBytes(speechFailure(null, "timeout"))
  })
  try {
    request.download({
      url: url,
      header: requestHeader.value,
      success: settle(function(data) {
        if (!currentEpoch(epoch)) return
        speechReport.phase = "download-accepted"
        var downloadToken = data && (data.token || data)
        if (!downloadToken) {
          orBytes(speechFailure(null, "no-token"))
          return
        }
        var settleFile = guard(UPLOAD_TIMEOUT_MS, function() {
          orBytes(speechFailure(null, "waiting-file"))
        })
        speechReport.phase = "waiting-file"
        awaitDownloaded(downloadToken, settleFile(function(uri) {
          if (!currentEpoch(epoch)) return
          speechReport.phase = "file-ready"
          onUri(uri)
        }), settleFile(function(code) {
          orBytes(speechFailure(code, "download-failed"))
        }))
      }),
      fail: settle(function(error, code) {
        orBytes(speechFailure(code, "request-failed"))
      })
    })
  } catch (error) {
    settle(function() { orBytes(speechFailure(null, "start-failed")) })()
  }
}

// Запасной транспорт: звук приезжает строкой base64 внутри обычного JSON.
//
// На Watch S5 request.download принимает вызов и заканчивается кодом 1000 —
// тринадцать опросов подряд за пятнадцать секунд, то есть это отказ, а не
// гонка. При этом @system.fetch с текстовым ответом работает: им ходит весь
// остальной обмен с шлюзом. Поэтому шлюз умеет отдать тот же звук текстом,
// а часы раскладывают его в файл и играют уже оттуда.
//
// 8 кГц запрашиваются намеренно: 24 кГц от Gemini дали бы втрое больше
// байт в куче JS, а документация @system.file предупреждает про «memory
// overload and application crashes» — на записи мы это уже ловили.
var FALLBACK_RATE = 8000
var MAX_BASE64_CHARS = 300000

var B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
var B64_LOOKUP = null

function base64Lookup() {
  if (B64_LOOKUP) return B64_LOOKUP
  // Таблица, а не indexOf на каждый символ: на двухстах тысячах символов
  // линейный поиск по алфавиту — это миллионы лишних сравнений.
  B64_LOOKUP = []
  for (var i = 0; i < 128; i++) B64_LOOKUP[i] = -1
  for (var j = 0; j < B64_ALPHABET.length; j++) B64_LOOKUP[B64_ALPHABET.charCodeAt(j)] = j
  return B64_LOOKUP
}

function decodeBase64(text) {
  var table = base64Lookup()
  var source = String(text || "")
  // Размер считается заранее, а не подрезается копией в конце: лишний
  // Uint8Array на 160 КБ — это ещё 160 КБ в куче ровно в тот момент, когда
  // там уже лежит и строка, и результат. Документация @system.file
  // предупреждает про «memory overload and application crashes» именно про
  // такие пики.
  var padding = 0
  if (source.charAt(source.length - 1) === "=") padding += 1
  if (source.charAt(source.length - 2) === "=") padding += 1
  var bytes = Math.floor(source.length / 4) * 3 - padding
  var out = new Uint8Array(bytes > 0 ? bytes : 0)
  var written = 0
  var accumulator = 0
  var bits = 0
  for (var i = 0; i < source.length; i++) {
    var code = source.charCodeAt(i)
    var value = code < 128 ? table[code] : -1
    if (value < 0) continue
    accumulator = (accumulator << 6) | value
    bits += 6
    if (bits >= 8) {
      bits -= 8
      if (written < out.length) out[written++] = (accumulator >> bits) & 255
    }
  }
  return out.buffer
}

function bytesUrl(url) {
  return url + (url.indexOf("?") >= 0 ? "&" : "?") + "as=base64&rate=" + FALLBACK_RATE
}

function fetchAudioBytes(url, onUri, onFail) {
  var epoch = speechEpoch
  var askedAt = Date.now()
  speechReport.fallback = "start"
  var settle = guard(UPLOAD_TIMEOUT_MS, function() {
    onFail(speechFailure(null, "fallback-timeout"))
  })
  var headers = { "Content-Type": "application/json" }
  var token = getCached().deviceToken
  if (token) headers["X-TimeW-Device-Token"] = token
  try {
    fetch.fetch({
      url: bytesUrl(url),
      method: "GET",
      header: headers,
      success: settle(function(response) {
        if (!currentEpoch(epoch)) return
        speechReport.timings.fetchMs = Date.now() - askedAt
        var body
        try {
          var raw = response && (response.data || response.body || response)
          body = typeof raw === "string" ? JSON.parse(raw) : raw
        } catch (parseError) {
          speechReport.fallback = "bad-json"
          onFail(speechFailure(null, "fallback-failed"))
          return
        }
        if (!body || !body.audioBase64) {
          speechReport.fallback = "no-audio"
          onFail(speechFailure(null, "fallback-failed"))
          return
        }
        if (body.audioBase64.length > MAX_BASE64_CHARS) {
          // Лучше честный отказ, чем убитое приложение: куча на часах
          // кончается раньше, чем терпение.
          speechReport.fallback = "too-big"
          onFail(speechFailure(null, "fallback-too-big"))
          return
        }
        var buffer
        var decodeStartedAt = Date.now()
        speechReport.timings.bytes = body.bytes || 0
        try {
          buffer = decodeBase64(body.audioBase64)
        } catch (decodeError) {
          speechReport.fallback = "decode-failed"
          onFail(speechFailure(null, "fallback-failed"))
          return
        }
        speechReport.timings.decodeMs = Date.now() - decodeStartedAt
        // Строка больше не нужна, а весит столько же, сколько сам звук.
        // Отпускаем её до записи файла, чтобы пик в куче был один, а не два.
        body.audioBase64 = null
        writeAudioFile(buffer, onUri, onFail)
      }),
      fail: settle(function(error, code) {
        if (!currentEpoch(epoch)) return
        speechReport.fallback = "fetch-failed"
        onFail(speechFailure(code, "fallback-failed"))
      })
    })
  } catch (error) {
    settle(function() {
      speechReport.fallback = "fetch-threw"
      onFail(speechFailure(null, "fallback-failed"))
    })()
  }
}

function writeAudioFile(buffer, onUri, onFail) {
  var epoch = speechEpoch
  if (!file || typeof file.writeArrayBuffer !== "function") {
    speechReport.fallback = "no-write"
    onFail(speechFailure(null, "fallback-failed"))
    return
  }
  // Имя одно на всё приложение: каждая озвучка перезаписывает предыдущую.
  // Нумерация копила бы файлы на часах до конца памяти — а чистить их
  // потом было бы нечем и некому.
  var uri = "internal://files/timew/speech.wav"
  var writeStartedAt = Date.now()
  var settle = guard(UPLOAD_TIMEOUT_MS, function() {
    speechReport.fallback = "write-timeout"
    onFail(speechFailure(null, "fallback-failed"))
  })
  function write() {
    try {
      file.writeArrayBuffer({
        uri: uri,
        buffer: buffer,
        success: settle(function() {
          if (!currentEpoch(epoch)) return
          speechReport.timings.writeMs = Date.now() - writeStartedAt
          speechReport.fallback = "ok"
          speechReport.transport = "fetch-base64"
          onUri(uri)
        }),
        fail: settle(function() {
          speechReport.fallback = "write-failed"
          onFail(speechFailure(null, "fallback-failed"))
        })
      })
    } catch (error) {
      settle(function() {
        speechReport.fallback = "write-threw"
        onFail(speechFailure(null, "fallback-failed"))
      })()
    }
  }
  // Каталога может не быть — очередь создаёт его тем же способом.
  if (typeof file.mkdir === "function") {
    try {
      file.mkdir({ uri: "internal://files/timew", recursive: true, success: write, fail: write })
      return
    } catch (error) {
      write()
      return
    }
  }
  write()
}

function download(speechId, done, fail) {
  fetchAudio(speechUrl(speechId), function(uri) {
    play(uri, done, fail)
  }, fail)
}

// Проверка динамика без траты запроса к модели: шлюз синтезирует свою
// фиксированную фразу. Возвращает наверх подробности для отчёта, а не только
// «получилось / не получилось».
export function speakTest(done, fail) {
  var startedAt = Date.now()
  var epoch = beginSpeech()
  mediaVolume(function(value) {
    if (!currentEpoch(epoch)) return
    lastPlayback = { started: false, error: "", volume: value }
    var url = baseUrl() + "/api/v1/speak/test?format=" +
      (getRecordingSettings().ttsFormat === "mp3" ? "mp3" : "wav")
    fetchAudio(url, function(uri) {
      var downloadedMs = Date.now() - startedAt
      play(uri, function() {
        done({ volume: value, uri: uri, downloadedMs: downloadedMs, ms: Date.now() - startedAt,
          started: lastPlayback.started, speech: lastSpeechReport() })
      }, function(error) {
        fail({ message: (error && error.message) || "не проигралось", volume: value,
          uri: uri, downloadedMs: downloadedMs, ms: Date.now() - startedAt,
          speech: lastSpeechReport() })
      })
    }, function(error) {
      error.volume = value
      error.ms = Date.now() - startedAt
      error.speech = lastSpeechReport()
      fail(error)
    })
  })
}

// Только для тестов: выученный за сессию отказ файловой загрузки на часах
// живёт до перезапуска приложения, а в тестах каждый случай свой.
export function resetSpeechTransport() {
  downloadUnusable = false
}

export function stopSpeaking() {
  // Отменённая озвучка не должна догнать следующую: всё, что прилетит от
  // прошлой попытки после этой строки, станет no-op.
  speechEpoch += 1
  try {
    if (typeof audio.stop === "function") audio.stop()
  } catch (error) {
    // Нечего останавливать — не ошибка.
  }
  if (activeFinish) activeFinish()
}
