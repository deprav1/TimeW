import storage from "@system.storage"
import { GATEWAY_URL, DEVICE_TOKEN, SPEAK_ANSWERS, AI_PROVIDER, TRANSFER_MODE, CONFIG_STAMP } from "./config"
import { guard } from "./guard"

var STORAGE_TIMEOUT_MS = 1000

// Настройки живут в @system.storage и переживают перезапуск приложения.
// config.js задаёт только значения по умолчанию для первой установки.
var DEFAULTS = {
  gatewayUrl: GATEWAY_URL,
  deviceToken: DEVICE_TOKEN,
  speakAnswers: SPEAK_ANSWERS,
  aiProvider: AI_PROVIDER,
  // Какой способ доставки записи сработал в прошлый раз: "bytes" или "upload".
  // Проверено в эмуляторе: request.upload молчит, работает чтение файла.
  // На реальной прошивке может быть наоборот, поэтому не зашиваем намертво.
  transferMode: TRANSFER_MODE,
  // Метка сборки, из которой пришли текущие адрес и токен.
  configStamp: CONFIG_STAMP,
  runtimeRevision: "local-1",
  runtimeConfig: {
    maxRecordingMs: 10000,
    silenceThreshold: 450,
    silenceDurationMs: 1000,
    speechGraceMs: 900,
    frameSize: 2048,
    requestTimeoutMs: 30000,
    uploadTimeoutMs: 60000,
    ttsFormat: "wav",
    autoStop: true
  }
}

var KEYS = ["gatewayUrl", "deviceToken", "speakAnswers", "aiProvider", "transferMode", "configStamp", "runtimeRevision", "runtimeConfig"]

var cached = copyDefaults()

function copyDefaults() {
  var result = {}
  KEYS.forEach(function(key) {
    result[key] = key === "runtimeConfig" ? copyRuntime(DEFAULTS.runtimeConfig) : DEFAULTS[key]
  })
  return result
}

function copyRuntime(value) {
  var source = value || DEFAULTS.runtimeConfig
  var result = {}
  Object.keys(DEFAULTS.runtimeConfig).forEach(function(key) {
    result[key] = source[key] === undefined ? DEFAULTS.runtimeConfig[key] : source[key]
  })
  return result
}

function normalizeUrl(url) {
  if (!url) return url
  if (url.length > 0 && url.charAt(url.length - 1) === "/") {
    return url.substring(0, url.length - 1)
  }
  return url
}

// storage хранит строки, поэтому булево значение ездит как "1"/"0".
function toStored(key, value) {
  if (key === "speakAnswers") return value ? "1" : "0"
  if (key === "runtimeConfig") {
    try { return JSON.stringify(copyRuntime(value)) } catch (error) { return "" }
  }
  return value === null || value === undefined ? "" : String(value)
}

function fromStored(key, raw) {
  if (raw === "" || raw === null || raw === undefined) return DEFAULTS[key]
  if (key === "speakAnswers") return raw === "1" || raw === "true"
  if (key === "gatewayUrl") return normalizeUrl(raw)
  if (key === "runtimeConfig") {
    try { return copyRuntime(JSON.parse(raw)) } catch (error) { return copyRuntime(DEFAULTS.runtimeConfig) }
  }
  return raw
}

// Читает ключи по одному: @system.storage не умеет доставать пачкой, а
// вложенные колбэки на каждый ключ быстро становятся нечитаемыми.
// Любая ошибка чтения — не повод зависнуть: подставляем значение по умолчанию
// и идём дальше, иначе экран настроек никогда не откроется.
// Новая сборка перекрывает сохранённые адрес и токен. Без этого установка
// свежего .rpk выглядела бы как «ничего не изменилось»: @system.storage
// переживает переустановку и продолжал бы отдавать настройки прошлой сборки.
// Остальные настройки (озвучка, провайдер, способ доставки) — выбор человека
// на часах, их сборка не трогает.
function applyBuildConfig(values) {
  if (values.configStamp === CONFIG_STAMP) return values
  values.gatewayUrl = GATEWAY_URL
  values.deviceToken = DEVICE_TOKEN
  values.configStamp = CONFIG_STAMP
  // Дозаписываем молча: если storage недоступен, человек всё равно работает
  // с правильными значениями, просто сверка повторится при следующем старте.
  ;["gatewayUrl", "deviceToken", "configStamp"].forEach(function(key) {
    storage.set({ key: key, value: toStored(key, values[key]), success: function() {}, fail: function() {} })
  })
  return values
}

function readKeys(index, accumulator, done) {
  // Vela storage is callback based, but each key is independent. Reading in
  // parallel keeps a silent module from costing one full timeout per key
  // (the old recursive version could delay the first screen by eight seconds
  // after a Bluetooth wake-up).
  if (index !== 0) return
  var pending = KEYS.length
  var finished = false
  var timeout = setTimeout(function() {
    if (finished) return
    finished = true
    KEYS.forEach(function(key) {
      if (accumulator[key] === undefined) accumulator[key] = key === "runtimeConfig" ? copyRuntime(DEFAULTS.runtimeConfig) : DEFAULTS[key]
    })
    cached = applyBuildConfig(accumulator)
    done(cached)
  }, STORAGE_TIMEOUT_MS)
  function complete(key, value) {
    if (finished) return
    accumulator[key] = value
    pending -= 1
    if (pending > 0) return
    finished = true
    clearTimeout(timeout)
    cached = applyBuildConfig(accumulator)
    done(cached)
  }
  KEYS.forEach(function(key) {
    try {
      storage.get({
        key: key,
        success: function(raw) { complete(key, fromStored(key, raw)) },
        fail: function() { complete(key, key === "runtimeConfig" ? copyRuntime(DEFAULTS.runtimeConfig) : DEFAULTS[key]) }
      })
    } catch (error) {
      complete(key, key === "runtimeConfig" ? copyRuntime(DEFAULTS.runtimeConfig) : DEFAULTS[key])
    }
  })
}

export function loadSettings(done) {
  readKeys(0, copyDefaults(), done)
}

function writeKeys(index, values, done, fail) {
  if (index >= KEYS.length) {
    cached = values
    if (done) done(cached)
    return
  }
  var key = KEYS[index]
  var settle = guard(STORAGE_TIMEOUT_MS, function() {
    if (fail) fail(new Error("Не удалось сохранить настройки на часах"))
  })
  try {
    storage.set({
      key: key,
      value: toStored(key, values[key]),
      success: settle(function() { writeKeys(index + 1, values, done, fail) }),
      fail: settle(function(error) { if (fail) fail(error) })
    })
  } catch (error) {
    settle(function() { if (fail) fail(error) })()
  }
}

export function saveSettings(settings, done, fail) {
  var values = copyDefaults()
  KEYS.forEach(function(key) {
    if (settings[key] !== undefined && settings[key] !== null) values[key] = settings[key]
  })
  values.gatewayUrl = normalizeUrl(values.gatewayUrl || GATEWAY_URL)
  values.deviceToken = values.deviceToken || ""
  writeKeys(0, values, done, fail)
}

// Accept only the bounded, non-secret tuning object from /api/v1/status.
// Invalid or partial values keep the last known-good value, so a malformed
// deployment can never make the watch record for minutes or wait forever.
function bounded(value, min, max, fallback) {
  var number = Number(value)
  if (!isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.round(number)))
}

export function applyRemoteRuntime(runtime, done) {
  if (!runtime || typeof runtime !== "object") {
    if (done) done(cached.runtimeConfig)
    return
  }
  var current = copyRuntime(cached.runtimeConfig)
  current.maxRecordingMs = bounded(runtime.maxRecordingMs, 3000, 30000, current.maxRecordingMs)
  current.silenceThreshold = bounded(runtime.silenceThreshold, 50, 12000, current.silenceThreshold)
  current.silenceDurationMs = bounded(runtime.silenceDurationMs, 400, 4000, current.silenceDurationMs)
  current.speechGraceMs = bounded(runtime.speechGraceMs, 300, 3000, current.speechGraceMs)
  current.frameSize = bounded(runtime.frameSize, 512, 4096, current.frameSize)
  current.requestTimeoutMs = bounded(runtime.requestTimeoutMs, 8000, 60000, current.requestTimeoutMs)
  current.uploadTimeoutMs = bounded(runtime.uploadTimeoutMs, 15000, 120000, current.uploadTimeoutMs)
  current.ttsFormat = runtime.ttsFormat === "mp3" ? "mp3" : "wav"
  current.autoStop = runtime.autoStop !== false
  cached.runtimeConfig = current
  cached.runtimeRevision = runtime.revision ? String(runtime.revision) : cached.runtimeRevision
  // One write instead of one write per field keeps the cold-start refresh
  // cheap on the watch's storage module.
  var pending = 2
  var completed = false
  var timeout = setTimeout(function() {
    if (completed) return
    completed = true
    if (done) done(cached.runtimeConfig)
  }, STORAGE_TIMEOUT_MS)
  var finish = function() {
    if (completed) return
    pending -= 1
    if (pending <= 0) {
      completed = true
      clearTimeout(timeout)
      if (done) done(cached.runtimeConfig)
    }
  }
  try {
    storage.set({ key: "runtimeRevision", value: toStored("runtimeRevision", cached.runtimeRevision), success: finish, fail: finish })
    storage.set({ key: "runtimeConfig", value: toStored("runtimeConfig", cached.runtimeConfig), success: finish, fail: finish })
  } catch (error) {
    clearTimeout(timeout)
    completed = true
    if (done) done(cached.runtimeConfig)
  }
}

export function getRecordingSettings() {
  return copyRuntime(cached.runtimeConfig)
}

// Запоминает сработавший способ доставки, чтобы в следующий раз не ждать
// таймаута заведомо молчащего пути.
export function rememberTransferMode(mode) {
  if (!mode || cached.transferMode === mode) return
  cached.transferMode = mode
  storage.set({ key: "transferMode", value: mode, success: function() {}, fail: function() {} })
}

export function getCached() {
  return cached
}
