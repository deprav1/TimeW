import record from "@system.record"
import { RECORD_TIMEOUT_MS } from "./config"
import { getRecordingSettings } from "./settings"
import { guard } from "./guard"

// Two capture paths are kept deliberately. PCM frames provide local
// end-of-speech detection; the proven Opus file path remains the fallback
// for firmware without frame events or parameters it rejects.
var active = null
var lastReport = {
  mode: "not-run", frameEventAvailable: false, frameCount: 0,
  frameBytes: [], signalMetrics: false, stoppedBySilence: false
}

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

// `in` only proves the runtime declares the slot, not that it ever fills it.
// Firmware that exposes `onframerecorded` and still delivers the recording
// through success() exists, so the property is a precondition, never a
// guarantee — see framedProven below.
function hasFrameEvents() {
  try {
    return !!record && "onframerecorded" in record
  } catch (error) { return false }
}

// Set once a capture ends with zero frames: the slot is declared but dead on
// this firmware. Remembering it for the rest of the session means at most one
// recording pays the detour. Deliberately not persisted — a module flag has no
// storage-schema blast radius, and relearning costs one capture per launch.
var framedUnsupported = false

function uriFrom(data) {
  var uri = data && (data.uri || data.path || data)
  return typeof uri === "string" && uri ? uri : ""
}

function contentTypeFor(uri, format) {
  var value = String(uri || "").toLowerCase()
  if (value.indexOf(".opus") >= 0) return "audio/opus"
  if (value.indexOf(".wav") >= 0) return "audio/wav"
  if (format === "opus") return "audio/opus"
  if (format === "wav") return "audio/wav"
  return "application/octet-stream"
}

function rms16(frame) {
  var bytes = frame instanceof Uint8Array ? frame : new Uint8Array(frame)
  if (bytes.length < 2) return 0
  var sum = 0
  var count = Math.floor(bytes.length / 2)
  for (var i = 0; i + 1 < bytes.length; i += 2) {
    var value = bytes[i] | (bytes[i + 1] << 8)
    if (value >= 32768) value -= 65536
    sum += value * value
  }
  return Math.sqrt(sum / count)
}

function copyBytes(value) {
  var source = value instanceof Uint8Array ? value : new Uint8Array(value)
  var result = new Uint8Array(source.length)
  result.set(source)
  return result
}

function writeAscii(view, offset, text) {
  for (var i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
}

function pcmFramesToWav(frames, sampleRate) {
  var length = 0
  frames.forEach(function(frame) { length += frame.length })
  var output = new Uint8Array(44 + length)
  var view = new DataView(output.buffer)
  writeAscii(view, 0, "RIFF")
  view.setUint32(4, 36 + length, true)
  writeAscii(view, 8, "WAVE")
  writeAscii(view, 12, "fmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeAscii(view, 36, "data")
  view.setUint32(40, length, true)
  var offset = 44
  frames.forEach(function(frame) { output.set(frame, offset); offset += frame.length })
  return output.buffer
}

function fileOptions(settings, format) {
  if (!format) return { duration: settings.maxRecordingMs }
  return {
    duration: settings.maxRecordingMs,
    sampleRate: 16000,
    numberOfChannels: 1,
    encodeBitRate: 22000,
    format: format
  }
}

function startFile(settings, done, fail, simplified, reportSeed) {
  var startedAt = Date.now()
  var cancelled = false
  var nextReport = {
    mode: simplified ? "file-default" : "file-opus",
    frameEventAvailable: hasFrameEvents(), frameCount: 0, frameBytes: [],
    signalMetrics: false, stoppedBySilence: false
  }
  if (reportSeed) {
    Object.keys(reportSeed).forEach(function(key) { nextReport[key] = reportSeed[key] })
    nextReport.mode = reportSeed.mode || nextReport.mode
  }
  lastReport = nextReport
  var settle = guard(Math.max(RECORD_TIMEOUT_MS, settings.maxRecordingMs + 8000), function() {
    stopRecording()
    fail(new Error("Запись не завершилась вовремя"))
  })
  var request = {
    success: settle(function(data) {
      if (cancelled) return
      active = null
      var uri = data && (data.uri || data.path || data)
      if (!uri || typeof uri !== "string") {
        fail(new Error("Рантайм не вернул путь к записи"))
        return
      }
      done({ uri: uri, contentType: contentTypeFor(uri, simplified ? "" : "opus"),
        recordedMs: Date.now() - startedAt, capture: lastReport })
    }),
    fail: settle(function(data, code) {
      if (cancelled) return
      active = null
      var error = errorFrom(data, code, "Не удалось записать голос")
      if (!simplified && error.code === 202) {
        startFile(settings, done, fail, true)
        return
      }
      fail(error)
    })
  }
  var options = fileOptions(settings, simplified ? "" : "opus")
  Object.keys(options).forEach(function(key) { request[key] = options[key] })
  active = {
    mode: "file",
    cancel: function() {
      cancelled = true
      if (settle.cancel) settle.cancel()
      active = null
      try { record.stop() } catch (error) {}
    }
  }
  try { record.start(request) } catch (error) {
    if (settle.cancel) settle.cancel()
    active = null
    fail(errorFrom(error, error && error.code, "Не удалось начать запись"))
  }
}

function startFramed(settings, done, fail) {
  var frames = []
  var startedAt = Date.now()
  var speechStarted = false
  var silenceStartedAt = 0
  var stopping = false
  var finished = false
  var cancelled = false
  var captured = null
  lastReport = {
    mode: "pcm-auto-stop", frameEventAvailable: true, frameCount: 0,
    frameBytes: [], signalMetrics: true, stoppedBySilence: false
  }

  // A capture can end three ways and firmware disagrees about which one it
  // uses: a last frame, complete(), or plain success(uri). All three funnel
  // here, and whichever arrives first wins. The uri that success() carries is
  // never thrown away — on firmware that declares onframerecorded but never
  // emits a frame it IS the recording, and discarding it used to leave the
  // screen counting until the watchdog fired and then silently re-record.
  function finishOk(data) {
    if (finished || cancelled) return
    finished = true
    if (settle.cancel) settle.cancel()
    active = null
    try { record.onframerecorded = null } catch (error) {}
    if (frames.length) {
      done({ bytes: pcmFramesToWav(frames, 16000), contentType: "audio/wav",
        recordedMs: Date.now() - startedAt, capture: lastReport })
      return
    }
    framedUnsupported = true
    var uri = uriFrom(data) || uriFrom(captured)
    if (uri) {
      lastReport.mode = "pcm-no-frames-file"
      done({ uri: uri, contentType: contentTypeFor(uri, ""),
        recordedMs: Date.now() - startedAt, capture: lastReport })
      return
    }
    // Nothing captured and no file handed back: the only remaining option is
    // to record again on the proven Opus path.
    lastReport.mode = "file-opus-fallback"
    startFile(settings, done, fail, false, lastReport)
  }

  var settle = guard(Math.max(RECORD_TIMEOUT_MS, settings.maxRecordingMs + 8000), function() {
    stopRecording()
    finishOk()
  })

  record.onframerecorded = function(event) {
    if (finished || !event || !event.frameBuffer) return
    var frame = copyBytes(event.frameBuffer)
    frames.push(frame)
    lastReport.frameCount += 1
    if (lastReport.frameBytes.length < 12) lastReport.frameBytes.push(frame.length)
    var now = Date.now()
    var energy = rms16(frame)
    if (energy >= settings.silenceThreshold) {
      speechStarted = true
      silenceStartedAt = 0
    } else if (speechStarted && now - startedAt >= settings.speechGraceMs) {
      if (!silenceStartedAt) silenceStartedAt = now
      if (!stopping && now - silenceStartedAt >= settings.silenceDurationMs) {
        stopping = true
        lastReport.stoppedBySilence = true
        stopRecording()
      }
    }
    if (event.isLastFrame) settle(finishOk)()
  }

  active = {
    mode: "framed",
    cancel: function() {
      cancelled = true
      finished = true
      if (settle.cancel) settle.cancel()
      active = null
      try { record.onframerecorded = null } catch (error) {}
      try { record.stop() } catch (error) {}
    }
  }
  try {
    record.start({
      duration: settings.maxRecordingMs,
      sampleRate: 16000,
      numberOfChannels: 1,
      encodeBitRate: 256000,
      frameSize: settings.frameSize,
      format: "pcm",
      // Recorded outside the guard as well: complete() may win the race with
      // success(), and the uri must survive that order too.
      success: function(data) {
        captured = data
        settle(finishOk)(data)
      },
      complete: settle(finishOk),
      fail: settle(function(data, code) {
        active = null
        framedUnsupported = true
        try { record.onframerecorded = null } catch (error) {}
        var captureError = errorFrom(data, code, "Автостоп записи недоступен")
        if (captureError.code === 202) {
          startFile(settings, done, fail, false)
          return
        }
        fail(captureError)
      })
    })
  } catch (error) {
    if (settle.cancel) settle.cancel()
    active = null
    try { record.onframerecorded = null } catch (ignored) {}
    startFile(settings, done, fail, false)
  }
}

export function stopRecording() {
  try { record.stop() } catch (error) {}
}

// Explicit cancellation is different from a natural stop (the latter lets
// the runtime deliver the captured file). It must detach callbacks first so a
// late complete event cannot trigger an Opus fallback or send stale audio.
export function cancelRecording() {
  if (active && typeof active.cancel === "function") {
    active.cancel()
    return
  }
  try { record.stop() } catch (error) {}
}

export function recordingCapability() {
  return {
    frameEventAvailable: hasFrameEvents(),
    framedUnsupported: framedUnsupported,
    last: lastReport
  }
}

// Only for tests: the learned flag is per-session on the device.
export function resetFrameSupport() {
  framedUnsupported = false
}

export function recordAudio(done, fail) {
  var settings = getRecordingSettings()
  if (settings.autoStop && !framedUnsupported && hasFrameEvents()) {
    startFramed(settings, done, fail)
    return
  }
  startFile(settings, done, fail, false)
}
