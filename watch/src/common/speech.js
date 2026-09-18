import request from "@system.request"
import audio from "@system.audio"
import { getCached } from "./settings"
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

function play(uri, done, fail) {
  try {
    audio.src = uri
    if (typeof audio.play === "function") audio.play()
    if (done) done()
  } catch (error) {
    fail({ message: "Часы не смогли проиграть ответ" })
  }
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
  request.download({
    url: baseUrl() + "/api/v1/speak/" + speechId,
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
    }),
    fail: settle(function(error, code) {
      fail({ message: messageForStatus(code) })
    })
  })
}

export function stopSpeaking() {
  try {
    if (typeof audio.stop === "function") audio.stop()
  } catch (error) {
    // Нечего останавливать — не ошибка.
  }
}
