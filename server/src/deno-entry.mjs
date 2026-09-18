// Точка входа для Deno Deploy.
//
// Зачем вообще: пока шлюз живёт на домашнем компьютере, часы работают только
// когда компьютер включён. Deno Deploy держит его всегда, бесплатно и без
// карты, а встроенный KV заменяет диск, которого там нет.
//
// Запуск локально (нужен установленный deno):
//   deno run -A --unstable-kv server/src/deno-entry.mjs
//
// Развёртывание: deployctl deploy --entrypoint server/src/deno-entry.mjs
// Переменные (DEVICE_TOKEN, AI_PROVIDER, AI_API_KEY и прочие) задаются в
// настройках проекта, а не файлом .env — файла там нет.

// Переменные окружения надо переложить в process.env ДО импорта шлюза:
// он читает конфигурацию один раз, на уровне модуля. Поэтому импорт
// динамический, а не обычный — обычный выполнился бы раньше этой строки.
const denoEnv = globalThis.Deno?.env;
if (denoEnv) {
  globalThis.process = globalThis.process || {};
  globalThis.process.env = { ...(globalThis.process.env || {}), ...denoEnv.toObject() };
}

const { route, config, setStore } = await import("./server.mjs");
const { createFetchHandler } = await import("./fetch-adapter.mjs");
const { createKvStore } = await import("./store.mjs");

// Хранилище открывается при первом обращении, а не при загрузке модуля.
//
// Причина практическая: если открыть его сразу и базы ещё нет, приложение
// не поднимается вовсе — снаружи видно только «revision failed», и понять
// что-либо можно лишь по логам сборки. А базу к новому приложению нельзя
// привязать до того, как оно создано: получается курица и яйцо.
// С отложенным открытием приложение поднимается всегда, а без базы честно
// отвечает ошибкой на запросы.
let kvPromise = null;
function openKv() {
  if (!kvPromise) kvPromise = globalThis.Deno.openKv();
  return kvPromise;
}

const kv = {
  async get(key) { return (await openKv()).get(key); },
  async set(key, value, options) { return (await openKv()).set(key, value, options); },
  async delete(key) { return (await openKv()).delete(key); },
  async *list(selector) {
    const db = await openKv();
    for await (const entry of db.list(selector)) yield entry;
  }
};

setStore(createKvStore(kv));

if (config.provider !== "mock" && !config.apiKey) {
  console.warn(`Внимание: AI_PROVIDER=${config.provider}, но AI_API_KEY пуст — шлюз фактически работает в demo-режиме.`);
}

const gateway = createFetchHandler(route, {
  log: config.logRequests ? (line) => console.log(`${new Date().toISOString()} ${line}`) : undefined
});

// Без токена шлюз в интернете беззащитен: адрес публичный, и любой желающий
// тратил бы ваш ключ AI и читал ваши заметки. Поэтому запросы не
// обслуживаются — но приложение при этом поднимается и говорит, что не так.
//
// Раньше здесь было исключение при старте. На хосте это худший вариант: он
// не поднимается вовсе, наружу видно только «revision failed», и причину
// приходится искать в логах сборки.
const handler = config.token
  ? gateway
  : () => {
      console.error("DEVICE_TOKEN не задан — задайте его в переменных приложения и выложите заново.");
      return new Response(
        JSON.stringify({ ok: false, error: { code: "not_configured", message: "Шлюз не настроен: не задан DEVICE_TOKEN" } }),
        { status: 503, headers: { "Content-Type": "application/json; charset=utf-8" } }
      );
    };

// На хосте порт и интерфейс назначает платформа, и указывать их нельзя:
// попытка слушать 127.0.0.1 внутри облака означает, что снаружи никто не
// достучится. Локально наоборот — нужен тот же порт, что у обычного запуска,
// иначе проверка стучится не туда.
//
// Признак локального запуска задаётся явно (TIMEW_LOCAL=1), а не угадывается
// по переменным платформы: их набор у Deploy менялся, и ошибка в угадывании
// проявляется только на живом хосте, где её труднее всего разглядеть.
const local = Boolean(globalThis.Deno.env.get("TIMEW_LOCAL"));
if (local) {
  globalThis.Deno.serve({ port: config.port, hostname: config.host }, handler);
} else {
  globalThis.Deno.serve(handler);
}
