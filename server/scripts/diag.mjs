// Показать отчёты диагностики, присланные часами.
//
//   npm run diag                        # шлюз по адресу из watch config / localhost
//   npm run diag -- https://my-gateway  # другой адрес
//
// Токен берётся из server/.env сам и на экран не выводится: копировать секрет
// руками перед каждым просмотром — верный способ однажды вставить его не туда.
//
// Отчёт лежит на шлюзе сутки, последние пять штук (GET /api/v1/diag).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

function fromEnvFile(name) {
  try {
    const text = readFileSync(join(here, "..", ".env"), "utf8");
    const match = text.match(new RegExp(`^\\s*${name}\\s*=\\s*(.*?)\\s*$`, "m"));
    return match ? match[1] : "";
  } catch {
    return "";
  }
}

// Адрес шлюза известен сборке часов — берём оттуда, чтобы смотреть ровно тот
// шлюз, с которым эти часы разговаривают.
function gatewayFromWatchConfig() {
  try {
    const text = readFileSync(join(here, "..", "..", "watch", "src", "common", "config.local.js"), "utf8");
    const match = text.match(/gatewayUrl:\s*["']([^"']*)["']/);
    return match ? match[1] : "";
  } catch {
    return "";
  }
}

const base = (
  process.argv.find((arg) => arg.startsWith("http")) ||
  process.env.GATEWAY_URL ||
  gatewayFromWatchConfig() ||
  "http://127.0.0.1:8787"
).replace(/\/$/, "");
const token = process.env.TOKEN || process.env.DEVICE_TOKEN || fromEnvFile("DEVICE_TOKEN");

const res = await fetch(`${base}/api/v1/diag`, {
  headers: token ? { "X-TimeW-Device-Token": token } : {}
});

if (res.status === 404) {
  console.error(`${base} отвечает 404 на GET /api/v1/diag.`);
  console.error("Скорее всего шлюз ещё не передеплоен: ручка появилась в коммите 1d1572c.");
  process.exit(1);
}
if (!res.ok) {
  console.error(`${base} ответил ${res.status}: ${(await res.text()).slice(0, 300)}`);
  process.exit(1);
}

const body = await res.json();
const reports = body.reports || [];
if (!reports.length) {
  console.log(`${base}: отчётов нет. Нажмите «Отправить отчёт» в «Диагностика → Проверить всё».`);
  process.exit(0);
}

console.log(`${base}: отчётов ${reports.length}, новые сверху.\n`);
reports.forEach((entry, index) => {
  console.log(`=== ${index + 1}. ${entry.receivedAt} (сборка шлюза ${entry.buildId}) ===`);
  try {
    console.log(JSON.stringify(JSON.parse(entry.report), null, 2));
  } catch {
    console.log(entry.report);
  }
  console.log("");
});
