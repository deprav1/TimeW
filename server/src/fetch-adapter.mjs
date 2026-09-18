// Переходник между «веб»-моделью HTTP и нашей.
//
// Шлюз написан в модели Node: обработчик получает поток запроса и объект
// ответа, в который пишет. Бесплатные хосты (Deno Deploy, Cloudflare, Vercel
// Edge) работают в другой модели: на вход Request, на выход Response.
//
// Переписывать под это все обработчики — значит трогать каждую строчку
// маршрутизации и половину тестов. Вместо этого одна прослойка: она
// притворяется парой req/res для route() и собирает из результата Response.
//
// Вся IO-поверхность шлюза узкая (тело читается асинхронным перебором, ответ
// пишется через writeHead + end), поэтому переходник помещается в один файл
// и проверяется обычными тестами на Node — Request и Response там настоящие.
import { Buffer } from "node:buffer";

function headersToObject(headers) {
  const result = {};
  // Имена заголовков в Node всегда в нижнем регистре, код на это опирается.
  for (const [name, value] of headers) result[name.toLowerCase()] = value;
  return result;
}

function requestShim(request) {
  const url = new URL(request.url);
  return {
    method: request.method,
    // route() разбирает это как new URL(req.url, "http://localhost"),
    // поэтому отдаём путь с query, а не абсолютный адрес.
    url: url.pathname + url.search,
    headers: headersToObject(request.headers),
    // Счётчик запросов берёт адрес клиента отсюда. В «веб»-модели сокета нет,
    // а настоящий адрес хост кладёт в X-Forwarded-For — его код и предпочтёт.
    socket: { remoteAddress: "" },
    async *[Symbol.asyncIterator]() {
      if (!request.body) return;
      const reader = request.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        yield Buffer.from(value);
      }
    }
  };
}

function responseShim() {
  const chunks = [];
  let headers = {};
  let settle;
  const finished = new Promise((resolve) => { settle = resolve; });

  const res = {
    statusCode: 200,
    headersSent: false,
    writeHead(status, nextHeaders) {
      res.statusCode = status;
      res.headersSent = true;
      if (nextHeaders) headers = { ...headers, ...nextHeaders };
      return res;
    },
    end(payload) {
      if (payload !== undefined && payload !== null) chunks.push(payload);
      settle();
      return res;
    },
    // Поток обрывают, когда заголовки уже ушли и внятный ответ не собрать.
    destroy() {
      settle();
      return res;
    },
    // route() вешает слушателя finish только ради лога запросов; здесь лог
    // пишет сам хост, поэтому подписка ничего не делает.
    on() { return res; }
  };

  return { res, finished, body: () => (chunks.length ? Buffer.concat(chunks.map((c) => Buffer.from(c))) : null), getHeaders: () => headers };
}

// route — обработчик шлюза, log — необязательная функция для строки лога.
export function createFetchHandler(route, { log } = {}) {
  return async function handler(request) {
    const startedAt = Date.now();
    const { res, finished, body, getHeaders } = responseShim();
    const req = requestShim(request);

    try {
      await Promise.race([route(req, res), finished]);
    } catch (cause) {
      // Та же политика, что и у Node-обёртки: наружу никогда не уходит
      // голый стек, а 500 не маскирует осмысленный код ошибки.
      const status = cause.statusCode || 500;
      if (!res.headersSent) {
        const payload = JSON.stringify({
          ok: false,
          error: {
            code: cause.code || (status === 500 ? "internal_error" : status >= 502 && status <= 504 ? "provider_error" : "request_error"),
            message: cause.publicMessage || (status === 500 ? "Internal server error" : cause.message)
          }
        });
        if (log) log(`${req.method} ${req.url}: ${cause.message}`);
        return new Response(payload, {
          status,
          headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" }
        });
      }
      if (log) log(`${req.method} ${req.url}: ${cause.message}`);
    }

    await finished;
    if (log) log(`${req.method} ${req.url} ${res.statusCode} ${Date.now() - startedAt}ms`);

    const payload = body();
    // 204 и 304 обязаны быть без тела — иначе рантайм ругается.
    const empty = res.statusCode === 204 || res.statusCode === 304;
    return new Response(empty ? null : payload, { status: res.statusCode, headers: getHeaders() });
  };
}
