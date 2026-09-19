// Сторожевой таймер для системных вызовов Vela.
//
// Проверено в эмуляторе: request.upload при отправке записи не вызвал ни
// success, ни fail — приложение осталось в состоянии «думаю…» навсегда.
// Молчащий модуль превращает часы в кирпич, и никакой фолбэк не спасает,
// если он завязан только на колбэк ошибки.
//
// Поэтому каждый вызов оборачивается здесь: побеждает первый наступивший
// исход — успех, ошибка или истёкшее время. Остальные игнорируются.
//
// Использование:
//   var settle = guard(15000, function() { fail({ message: "…" }) })
//   api.call({ success: settle(onOk), fail: settle(onErr) })

export function guard(timeoutMs, onTimeout) {
  var finished = false
  var timer = setTimeout(function() {
    if (finished) return
    finished = true
    if (onTimeout) onTimeout()
  }, timeoutMs)

  function settle(handler) {
    return function() {
      if (finished) return
      finished = true
      clearTimeout(timer)
      if (handler) handler.apply(null, arguments)
    }
  }
  // Synchronous exceptions can happen before a callback is registered. Give
  // callers a way to close the watchdog immediately instead of keeping the
  // process (and the watch page) alive until the full timeout.
  settle.cancel = function() {
    if (finished) return
    finished = true
    clearTimeout(timer)
  }
  return settle
}
