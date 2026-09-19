import request from "@system.request"
import audio from "@system.audio"
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

function play(uri, done, fail) {
  var settled = false
  function finishOk() {
    if (settled) return
    settled = true
    if (activeFinish === finishOk) activeFinish = null
    audio.onended = null
    audio.onstop = null
    audio.onerror = null
    if (done) done()
  }
  function finishError(error) {
    if (settled) return
    settled = true
    if (activeFinish === finishOk) activeFinish = null
    audio.onended = null
    audio.onstop = null
    audio.onerror = null
    if (fail) fail(error || { message: "Часы не смогли проиграть ответ" })
  }
  activeFinish = finishOk
  try {
    audio.onended = finishOk
    // A stop is terminal for the UI too: the user explicitly asked to stop.
    audio.onstop = finishOk
    audio.onerror = function() { finishError({ message: "Часы не смогли проиграть ответ" }) }
    audio.src = uri
    if (typeof audio.play !== "function") throw new Error("audio.play is unavailable")
    audio.play()
  } catch (error) {
    finishError({ message: "Часы не смогли проиграть ответ" })
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
