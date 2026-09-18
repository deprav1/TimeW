import record from "@system.record"
import { MAX_RECORDING_MS, RECORD_TIMEOUT_MS } from "./config"
import { guard } from "./guard"

// Запись голоса на Xiaomi Watch S5.
//
// Модуль @system.record официально документирован Xiaomi:
// https://iot.mi.com/vela/quickapp/en/features/system/record.html
// В таблице поддержки запись есть ТОЛЬКО у Watch S5 — на S3/S4, Redmi Watch
// и всех Band она отсутствует. Поэтому приложение и делалось под S5.
//
// Ключевая особенность: success отдаёт не байты, а { uri } — путь к файлу в
// кэше приложения. Как именно этот файл доставить на шлюз, документация не
// описывает, поэтому адаптер отдаёт uri наверх, а выбор способа отправки
// остаётся в api.js (там реализованы два пути с фолбэком).
//
// Что ещё не проверено на живом устройстве (см. docs/physical-checklist.md):
// принимает ли конкретная прошивка format "opus"/"wav"; какая схема у uri;
// нужен ли config.background.features при погасшем экране; есть ли системный
// диалог разрешения микрофона.

// Документация Xiaomi: 200 — нет места, 202 — неверные параметры,
// 205 — запись уже идёт.
function messageForCode(code) {
  if (code === 200) return "На часах не хватает места для записи"
  if (code === 202) return "Рантайм отклонил параметры записи"
  if (code === 205) return "Запись уже идёт"
  return ""
}

function errorFrom(data, code, fallback) {
  var text = messageForCode(code)
  if (!text && data && data.message) text = data.message
  if (!text) text = fallback
  var error = new Error(text)
  error.code = code
  return error
}

// Основной набор параметров — из документации Xiaomi для S5.
// Opus 16 кГц mono: компактно и достаточно для распознавания речи.
function primaryOptions() {
  return {
    duration: MAX_RECORDING_MS,
    sampleRate: 16000,
    numberOfChannels: 1,
    // Xiaomi's 16 kHz mono Opus guidance puts the efficient range below
    // 23 kbps. 22 kbps keeps speech clear while avoiding needless upload
    // size on a watch/phone link.
    encodeBitRate: 22000,
    format: "opus"
  }
}

// Запасной набор. На watchdoc.quickapp.cn тот же модуль описан в упрощённом
// виде — без выбора формата, с фиксированными дефолтами. Если прошивка
// окажется ближе к тому варианту, подробные параметры вернут код 202, и
// тогда имеет смысл позвать start вообще без них.
function fallbackOptions() {
  return { duration: MAX_RECORDING_MS }
}

function contentTypeFor(uri, format) {
  var value = String(uri || "").toLowerCase()
  if (value.indexOf(".opus") >= 0) return "audio/opus"
  if (value.indexOf(".wav") >= 0) return "audio/wav"
  if (value.indexOf(".pcm") >= 0) return "application/octet-stream"
  if (format === "opus") return "audio/opus"
  if (format === "wav") return "audio/wav"
  return "application/octet-stream"
}

function start(options, format, done, fail) {
  // Если рантайм не вызовет ни success, ни fail, запись просто не завершится
  // и приложение останется в состоянии «слушаю…» навсегда.
  var settle = guard(RECORD_TIMEOUT_MS, function() {
    stopRecording()
    fail(new Error("Запись не завершилась вовремя"))
  })

  function settleOk(data) {
    var uri = data && (data.uri || data.path || data)
    if (!uri || typeof uri !== "string") {
      fail(new Error("Рантайм не вернул путь к записи"))
      return
    }
    done({ uri: uri, contentType: contentTypeFor(uri, format) })
  }

  function settleFail(data, code) {
    fail(errorFrom(data, code, "Не удалось записать голос"))
  }

  var request = {
    success: settle(settleOk),
    fail: settle(settleFail)
  }
  Object.keys(options).forEach(function(key) { request[key] = options[key] })

  try {
    record.start(request)
  } catch (error) {
    // Vela may reject an unsupported format or a missing microphone
    // permission synchronously, without invoking fail. Treat that exactly
    // like an asynchronous failure so the page never remains busy forever.
    settle(function() { fail(errorFrom(error, error && error.code, "Не удалось начать запись")) })()
  }
}

// Останавливает запись досрочно. duration уже задан, поэтому в обычном
// сценарии останавливать вручную не нужно — но кнопка «стоп» на это опирается.
export function stopRecording() {
  try {
    record.stop()
  } catch (error) {
    // Рантайм может не иметь stop, если запись уже завершилась сама.
  }
}

export function recordAudio(done, fail) {
  start(primaryOptions(), "opus", done, function(error) {
    // 202 означает «неверные параметры»: пробуем упрощённый вызов, прежде
    // чем сдаваться. Все прочие коды — настоящие ошибки, их отдаём сразу.
    if (error && error.code === 202) {
      start(fallbackOptions(), "", done, fail)
      return
    }
    fail(error)
  })
}
