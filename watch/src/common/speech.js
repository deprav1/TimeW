import request from "@system.request"
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
  return "Не удалось получить озвучку"
}

var activeFinish = null
var lastPlayback = { started: false, error: "", volume: -1 }

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
  // Ноль громкости даёт ровно то же наблюдаемое поведение, что и сломанная
  // озвучка: тишина. Разница в одну строку на экране экономит час поисков.
  mediaVolume(function(value) {
    if (value >= 0 && value < 0.05) {
      fail({ message: "Звук на часах выключен" })
      return
    }
    download(speechId, done, fail)
  })
}

function download(speechId, done, fail) {
  var downloadHeaders = {}
  var token = getCached().deviceToken
  if (token) downloadHeaders["X-TimeW-Device-Token"] = token

  var settle = guard(UPLOAD_TIMEOUT_MS, function() {
    fail({ message: "Озвучка не пришла вовремя" })
  })
  try {
    request.download({
    url: speechUrl(speechId),
    header: downloadHeaders,
    success: settle(function(data) {
      var downloadToken = data && (data.token || data)
      if (!downloadToken) {
        fail({ message: "Шлюз не отдал озвучку" })
        return
      }
      var settleComplete = guard(UPLOAD_TIMEOUT_MS, function() {
        fail({ message: "Озвучка не пришла вовремя" })
      })
      try {
        request.onDownloadComplete({
          token: downloadToken,
          success: settleComplete(function(result) {
            var uri = result && (result.uri || result)
            if (!uri) {
              fail({ message: "Файл озвучки не найден" })
              return
            }
            play(uri, done, fail)
          }),
          fail: settleComplete(function(error, code) {
            fail({ message: messageForStatus(code) })
          })
        })
      } catch (error) {
        settleComplete(function() { fail({ message: "Не удалось получить файл озвучки" }) })()
      }
    }),
    fail: settle(function(error, code) {
      fail({ message: messageForStatus(code) })
    })
    })
  } catch (error) {
    settle(function() { fail({ message: "Не удалось начать загрузку озвучки" }) })()
  }
}

export function stopSpeaking() {
  try {
    if (typeof audio.stop === "function") audio.stop()
  } catch (error) {
    // Нечего останавливать — не ошибка.
  }
  if (activeFinish) activeFinish()
}
