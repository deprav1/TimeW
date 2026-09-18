import storage from "@system.storage"
import { GATEWAY_URL, DEVICE_TOKEN, SPEAK_ANSWERS, AI_PROVIDER, TRANSFER_MODE, CONFIG_STAMP } from "./config"

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
  configStamp: CONFIG_STAMP
}

var KEYS = ["gatewayUrl", "deviceToken", "speakAnswers", "aiProvider", "transferMode", "configStamp"]

var cached = copyDefaults()

function copyDefaults() {
  var result = {}
  KEYS.forEach(function(key) { result[key] = DEFAULTS[key] })
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
  return value === null || value === undefined ? "" : String(value)
}

function fromStored(key, raw) {
  if (raw === "" || raw === null || raw === undefined) return DEFAULTS[key]
  if (key === "speakAnswers") return raw === "1" || raw === "true"
  if (key === "gatewayUrl") return normalizeUrl(raw)
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
  if (index >= KEYS.length) {
    cached = applyBuildConfig(accumulator)
    done(cached)
    return
  }
  var key = KEYS[index]
  storage.get({
    key: key,
    success: function(raw) {
      accumulator[key] = fromStored(key, raw)
      readKeys(index + 1, accumulator, done)
    },
    fail: function() {
      accumulator[key] = DEFAULTS[key]
      readKeys(index + 1, accumulator, done)
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
  storage.set({
    key: key,
    value: toStored(key, values[key]),
    success: function() { writeKeys(index + 1, values, done, fail) },
    fail: function(error) { if (fail) fail(error) }
  })
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
