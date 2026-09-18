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

const kv = await globalThis.Deno.openKv();
setStore(createKvStore(kv));

// Без токена шлюз в интернете беззащитен: его адрес публичный, и любой
// желающий тратил бы ваш ключ AI и читал ваши заметки. Лучше не подняться
// совсем, чем подняться открытым.
if (!config.token) {
  throw new Error("DEVICE_TOKEN не задан. Задайте его в переменных проекта — без него шлюз нельзя выставлять в интернет.");
}
if (config.provider !== "mock" && !config.apiKey) {
  console.warn(`Внимание: AI_PROVIDER=${config.provider}, но AI_API_KEY пуст — шлюз фактически работает в demo-режиме.`);
}

const handler = createFetchHandler(route, {
  log: config.logRequests ? (line) => console.log(`${new Date().toISOString()} ${line}`) : undefined
});

// На Deno Deploy порт назначает платформа, и указывать его нельзя.
// Локально — берём тот же PORT, что и обычный запуск, иначе Deno molча
// слушал бы свой порт по умолчанию, а проверка стучалась бы не туда.
const onDeploy = Boolean(globalThis.Deno.env.get("DENO_DEPLOYMENT_ID"));
if (onDeploy) {
  globalThis.Deno.serve(handler);
} else {
  globalThis.Deno.serve({ port: config.port, hostname: config.host }, handler);
}
