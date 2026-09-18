import network from "@system.network"
import { guard } from "./guard"

// Проверка сети на часах.
//
// Взято из разбора реальных Vela-приложений в образе эмулятора (Ximalaya,
// QQ): оба объявляют system.network и перед работой спрашивают тип сети,
// считая "none" отсутствием подключения.
//
// Зачем это нам: без такой проверки любая неудача выглядит одинаково, и
// человек идёт чинить адрес шлюза, когда на часах просто нет Wi-Fi.
// Плюс досылать отложенные заметки в офлайне бессмысленно.

var CHECK_TIMEOUT_MS = 4000

// done(online) — true, если сеть есть. При любой неясности возвращаем true:
// лучше попробовать запрос и получить внятную ошибку от шлюза, чем молча
// отказать пользователю из-за неудавшейся проверки.
export function isOnline(done) {
  var settle = guard(CHECK_TIMEOUT_MS, function() {
    done(true)
  })

  var onOk = settle(function(data) {
    var type = data && (data.type || data.metered === undefined ? data.type : data)
    done(!type || type !== "none")
  })
  var onFail = settle(function() {
    done(true)
  })

  try {
    var result = network.getType({ success: onOk, fail: onFail })
    // В некоторых сборках getType возвращает промис вместо колбэков.
    if (result && typeof result.then === "function") {
      result.then(onOk, onFail)
    }
  } catch (error) {
    onFail()
  }
}
