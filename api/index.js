// Тонкий прокси перед шлюзом.
//
// Зачем он вообще нужен: TLS-стек Xiaomi Watch S5 не понимает сертификаты
// на эллиптических кривых (ECDSA). Проверено на устройстве — запрос к
// адресам с такими сертификатами обрывается с ошибкой 35 ещё до ответа
// сервера:
//
//   api.telegram.org  RSA 2048   → 200
//   google.com        ECDSA      → 35
//   cloudflare.com    ECDSA      → 35
//   наш адрес на Deno ECDSA      → 35
//
// Сменить сертификат на Deno нельзя, а *.vercel.app отдаёт RSA. Поэтому
// часы обращаются сюда, а вся логика остаётся на шлюзе: этот файл только
// пересылает запросы и ответы как есть.
//
// Тело не разбираем: через прокси идёт и JSON, и сырые байты записи, и
// WAV озвучки. Любой разбор здесь их испортил бы.
export const config = { api: { bodyParser: false } };

const TARGET = (process.env.TIMEW_TARGET || "https://timew.deprav1.deno.net").replace(/\/$/, "");

// Заголовки, которые нельзя передавать дальше: они описывают именно наше
// соединение, а не запрос. Content-Length пересчитает сам fetch.
const SKIP_REQUEST = new Set(["host", "connection", "content-length", "transfer-encoding"]);
const SKIP_RESPONSE = new Set(["content-encoding", "content-length", "transfer-encoding", "connection"]);

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

export default async function handler(req, res) {
  try {
    const headers = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (!SKIP_REQUEST.has(name.toLowerCase())) headers[name] = value;
    }

    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
    const upstream = await fetch(TARGET + req.url, { method: req.method, headers, body });
    const payload = Buffer.from(await upstream.arrayBuffer());

    res.statusCode = upstream.status;
    upstream.headers.forEach((value, name) => {
      if (!SKIP_RESPONSE.has(name.toLowerCase())) res.setHeader(name, value);
    });
    res.end(payload);
  } catch (cause) {
    // Прокси не должен выдавать свою поломку за ответ шлюза: пусть часы
    // видят, что не дошло именно до шлюза.
    res.statusCode = 502;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: false, error: { code: "proxy_error", message: `Прокси не смог связаться со шлюзом: ${cause.message}` } }));
  }
}
