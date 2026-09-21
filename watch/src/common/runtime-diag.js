import device from "@system.device"
import record from "@system.record"
import file from "@system.file"
import audio from "@system.audio"
import volume from "@system.volume"
import { guard } from "./guard"

// This module intentionally does not import the speech or recording helpers.
// The diagnostic capture must answer one narrow question: can this firmware
// accept Xiaomi's documented file-recording call when no playback transition
// happened immediately before it?

function shape(value) {
  if (value === null || value === undefined) return null
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value
  try { return JSON.stringify(value).slice(0, 500) } catch (error) { return String(value).slice(0, 500) }
}

function codeOf(error, code) {
  if (typeof code === "number") return code
  if (error && typeof error.code === "number") return error.code
  return null
}

function call(name, method, done) {
  var started = Date.now()
  if (!method || typeof method !== "function") {
    done({ name: name, available: false, value: null, code: null, error: "метод отсутствует", ms: 0 })
    return
  }
  var settle = guard(1800, function() {
    done({ name: name, available: true, value: null, code: null, error: "нет callback за 1800 мс", ms: Date.now() - started })
  })
  try {
    method({
      success: settle(function(value) {
        done({ name: name, available: true, value: value || null, code: null, error: "", ms: Date.now() - started })
      }),
      fail: settle(function(error, code) {
        done({ name: name, available: true, value: null, code: codeOf(error, code), error: shape(error) || "ошибка", ms: Date.now() - started })
      })
    })
  } catch (error) {
    settle(function() {
      done({ name: name, available: true, value: null, code: codeOf(error), error: shape(error) || "исключение", ms: Date.now() - started })
    })()
  }
}

function moduleMethods(module, methods) {
  return methods.reduce(function(result, name) {
    var present = false
    try { present = !!module && typeof module[name] === "function" } catch (error) { present = false }
    result[name] = present
    return result
  }, {})
}

function storageValue(entry, field) {
  return entry && entry.value && typeof entry.value[field] === "number" ? entry.value[field] : null
}

export function collectRuntimeDiagnostics(done) {
  var result = {
    device: null,
    storage: { totalBytes: null, availableBytes: null },
    audioState: null,
    mediaVolume: null,
    methods: {
      device: moduleMethods(device, ["getInfo", "getTotalStorage", "getAvailableStorage"]),
      record: moduleMethods(record, ["start", "stop"]),
      file: moduleMethods(file, ["readArrayBuffer", "delete"]),
      audio: moduleMethods(audio, ["play", "stop", "getPlayState"]),
      volume: moduleMethods(volume, ["getMediaValue"])
    }
  }
  var jobs = [
    function(next) { call("device.getInfo", device && device.getInfo, function(entry) { result.device = entry.value || { error: entry.error, code: entry.code }; next() }) },
    function(next) { call("device.getTotalStorage", device && device.getTotalStorage, function(entry) { result.storage.totalBytes = storageValue(entry, "totalStorage"); result.storage.totalProbe = entry; next() }) },
    function(next) { call("device.getAvailableStorage", device && device.getAvailableStorage, function(entry) { result.storage.availableBytes = storageValue(entry, "availableStorage"); result.storage.availableProbe = entry; next() }) },
    function(next) { call("audio.getPlayState", audio && audio.getPlayState, function(entry) { result.audioState = entry; next() }) },
    function(next) { call("volume.getMediaValue", volume && volume.getMediaValue, function(entry) { result.mediaVolume = entry.value && typeof entry.value.value === "number" ? entry.value.value : entry; next() }) }
  ]
  var index = 0
  function runNext() {
    if (index >= jobs.length) { done(result); return }
    jobs[index++](runNext)
  }
  runNext()
}

function bytesHead(bytes) {
  var head = ""
  try {
    var view = new Uint8Array(bytes)
    for (var i = 0; i < 16 && i < view.length; i++) {
      var value = view[i].toString(16)
      head += (value.length < 2 ? "0" + value : value)
    }
  } catch (error) { return "не прочитать" }
  return head
}

function finishFile(report, uri, done) {
  var started = Date.now()
  var settle = guard(2500, function() {
    report.fileRead = { ok: false, error: "файл не прочитался вовремя", ms: Date.now() - started }
    done(report, null)
  })
  try {
    file.readArrayBuffer({
      uri: uri,
      success: settle(function(data) {
        var bytes = data && (data.buffer || data)
        var size = bytes ? (bytes.byteLength || bytes.length || 0) : 0
        report.fileRead = { ok: !!bytes, size: size, head: bytesHead(bytes), ms: Date.now() - started }
        var captured = bytes || null
        function finish() { done(report, captured) }
        if (typeof file.delete !== "function") { finish(); return }
        try {
          file.delete({ uri: uri, success: finish, fail: finish })
        } catch (error) { finish() }
      }),
      fail: settle(function(error, code) {
        report.fileRead = { ok: false, code: codeOf(error, code), error: shape(error) || "ошибка чтения", ms: Date.now() - started }
        done(report, null)
      })
    })
  } catch (error) {
    settle(function() {
      report.fileRead = { ok: false, code: codeOf(error), error: shape(error) || "исключение чтения", ms: Date.now() - started }
      done(report, null)
    })()
  }
}

var OFFICIAL_RECORD_PROFILE = {
  // Xiaomi's published example uses a 10-second PCM capture. Keep this
  // exact in the first A/B call; shorter durations are useful later, but are
  // not the official control profile for this firmware.
  duration: 10000, sampleRate: 8000, numberOfChannels: 1,
  encodeBitRate: 128000, format: "pcm"
}

export function probeMinimalRecording(done, profile) {
  var started = Date.now()
  var selected = profile || OFFICIAL_RECORD_PROFILE
  var report = {
    isolated: true,
    beforePlaybackStop: false,
    // Use Xiaomi's exact documented PCM profile. The standalone probe showed
    // that this S5 rejects an Opus call when its bitrate is left at the PCM
    // default, even though the docs say out-of-range Opus bitrates may work.
    request: {
      duration: selected.duration,
      sampleRate: selected.sampleRate,
      numberOfChannels: selected.numberOfChannels,
      encodeBitRate: selected.encodeBitRate,
      format: selected.format
    },
    callbacks: { successMs: null, failMs: null, completeMs: null },
    observed: "pending",
    code: null,
    rawError: "",
    successShape: null
  }
  var finished = false
  var successData = null
  var completeTimer = 0
  function finish(kind, error, code) {
    if (finished) return
    finished = true
    if (completeTimer) clearTimeout(completeTimer)
    report.observed = kind
    report.code = codeOf(error, code)
    report.rawError = shape(error) || ""
    report.interpretation = kind === "success" ? "capture_success" :
      (report.code === 202 ? "runtime_parameter_error_according_to_xiaomi_docs; permission_not_proven" : "capture_failed")
    report.ms = Date.now() - started
    var uri = successData && (successData.uri || successData.path || successData)
    if (kind === "success" && typeof uri === "string" && uri) {
      report.successShape = { keys: successData && typeof successData === "object" ? Object.keys(successData).slice(0, 12) : [], uriKind: uri.indexOf("internal://") === 0 ? "internal" : "other" }
      finishFile(report, uri, done)
      return
    }
    done(report, null)
  }
  var options = {
    duration: report.request.duration,
    sampleRate: report.request.sampleRate,
    numberOfChannels: report.request.numberOfChannels,
    encodeBitRate: report.request.encodeBitRate,
    format: report.request.format,
    success: function(data) {
      successData = data
      report.callbacks.successMs = Date.now() - started
      finish("success", null, null)
    },
    fail: function(error, code) {
      report.callbacks.failMs = Date.now() - started
      finish("fail", error, code)
    },
    complete: function() {
      report.callbacks.completeMs = Date.now() - started
      // Some firmware calls complete before success. Give success its data
      // instead of declaring a false empty capture.
      completeTimer = setTimeout(function() { finish("complete", null, null) }, 250)
    }
  }
  var timer = setTimeout(function() {
    try { if (record && typeof record.stop === "function") record.stop() } catch (error) {}
    finish("timeout", null, null)
  }, Math.max(7000, report.request.duration + 2000))
  var originalDone = done
  done = function(reportValue, bytes) { clearTimeout(timer); originalDone(reportValue, bytes) }
  try { record.start(options) } catch (error) { finish("throw", error, error && error.code) }
}

// One diagnostic run may compare the three documented S5 file profiles. This
// is deliberately separate from normal voice capture: it never retries a
// failed profile, waits between successful sessions, and reports each raw
// callback independently.
export function probeRecordingProfiles(done) {
  var profiles = [
    OFFICIAL_RECORD_PROFILE,
    { duration: 3000, sampleRate: 8000, numberOfChannels: 1, encodeBitRate: 12800, format: "opus" },
    { duration: 3000, sampleRate: 8000, numberOfChannels: 1, encodeBitRate: 128000, format: "wav" }
  ]
  var results = []
  var captures = []
  function next(index) {
    if (index >= profiles.length) { done(results, captures); return }
    probeMinimalRecording(function(result, bytes) {
      result.profile = result.request.format
      results.push(result)
      captures.push({ format: result.request.format, bytes: bytes || null })
      setTimeout(function() { next(index + 1) }, 350)
    }, profiles[index])
  }
  next(0)
}
