// Один шаг между «склонировал» и «работает».
//
// Раньше запуск требовал четырёх ручных действий: скопировать .env.example,
// придумать и вписать DEVICE_TOKEN, узнать адрес машины в домашней сети и
// вписать его вместе с токеном в watch/src/common/config.js перед сборкой
// .rpk. Любая опечатка выглядела на часах одинаково — «Нет связи со шлюзом».
//
// Скрипт делает всё это сам и печатает то, что нельзя вывести иначе:
// какой адрес попал в сборку часов и в каком режиме поднимется шлюз.
//
//   node scripts/setup.mjs                # домашняя сеть (HOST=0.0.0.0)
//   node scripts/setup.mjs --localhost    # только 127.0.0.1, наружу — туннель
//   node scripts/setup.mjs --new-token    # перевыпустить токен устройства
//   node scripts/setup.mjs --url https://timew.example  # явный адрес шлюза
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { networkInterfaces } from "node:os";

const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_DIR = join(SERVER_DIR, "..");
const ENV_PATH = join(SERVER_DIR, ".env");
const EXAMPLE_PATH = join(SERVER_DIR, ".env.example");
const WATCH_CONFIG_PATH = join(REPO_DIR, "watch", "src", "common", "config.local.js");

const args = process.argv.slice(2);
const localhostOnly = args.includes("--localhost");
const forceNewToken = args.includes("--new-token");
const urlIndex = args.indexOf("--url");
const explicitUrl = urlIndex !== -1 ? args[urlIndex + 1] : undefined;

if (urlIndex !== -1 && !explicitUrl) {
  console.error("--url требует адрес, например: --url https://timew.example");
  process.exit(1);
}

// .env — построчный формат, а не JSON: правим текст, сохраняя комментарии и
// порядок строк, чтобы файл оставался читаемым после нескольких прогонов.
function readEnvValue(text, key) {
  const match = text.match(new RegExp(`^\\s*${key}\\s*=\\s*(.*?)\\s*$`, "m"));
  return match ? match[1] : undefined;
}

function writeEnvValue(text, key, value) {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^\\s*${key}\\s*=.*$`, "m");
  if (pattern.test(text)) return text.replace(pattern, line);
  return `${text.replace(/\s*$/, "")}\n${line}\n`;
}

// Адрес, по которому часы видят эту машину. Часы и компьютер в одной
// домашней сети, поэтому нужен именно LAN-адрес: 127.0.0.1 с часов
// указывает на сами часы, а не на шлюз.
function detectLanAddress() {
  const candidates = [];
  const interfaces = networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const entry of interfaces[name] || []) {
      const family = entry.family === "IPv4" || entry.family === 4;
      if (!family || entry.internal) continue;
      candidates.push(entry.address);
    }
  }
  // Приоритет частным диапазонам: у VPN и виртуальных адаптеров часто
  // тоже есть внешне выглядящие адреса, но часы до них не достучатся.
  const isPrivate = (ip) => /^192\.168\./.test(ip) || /^10\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
  return candidates.find(isPrivate) || candidates[0] || null;
}

function maskToken(token) {
  if (!token) return "(не задан)";
  return token.length <= 8 ? "••••" : `••••${token.slice(-4)}`;
}

async function main() {
  // 1. .env: создаём из примера, если его ещё нет.
  let created = false;
  if (!existsSync(ENV_PATH)) {
    if (!existsSync(EXAMPLE_PATH)) {
      console.error("Не найден server/.env.example — нечего копировать.");
      process.exit(1);
    }
    await writeFile(ENV_PATH, await readFile(EXAMPLE_PATH, "utf8"), "utf8");
    created = true;
  }
  let env = await readFile(ENV_PATH, "utf8");

  // 2. Токен устройства: без него открытый наружу шлюз тратит чужой AI-ключ
  // и отдаёт чужие заметки. Генерируем сами, чтобы его не надо было
  // придумывать и переносить руками.
  let token = readEnvValue(env, "DEVICE_TOKEN") || "";
  const tokenIsNew = forceNewToken || !token;
  if (tokenIsNew) {
    token = randomBytes(24).toString("base64url");
    env = writeEnvValue(env, "DEVICE_TOKEN", token);
  }

  // 3. Интерфейс прослушивания. Для часов в домашней сети нужен 0.0.0.0;
  // для варианта с туннелем шлюз остаётся на 127.0.0.1, а наружу его
  // отдаёт туннель (см. docs/deploy.md).
  const host = localhostOnly ? "127.0.0.1" : "0.0.0.0";
  env = writeEnvValue(env, "HOST", host);
  const port = readEnvValue(env, "PORT") || "8787";

  await writeFile(ENV_PATH, env, "utf8");

  // 4. Адрес, который попадёт в сборку часов.
  const lan = detectLanAddress();
  const gatewayUrl = explicitUrl
    ? explicitUrl.replace(/\/$/, "")
    : localhostOnly
      ? ""
      : lan
        ? `http://${lan}:${port}`
        : "";

  // 5. config.local.js — единственное место, где адрес и токен попадают в
  // сборку часов. Файл в .gitignore, поэтому боевой токен не уезжает в
  // историю репозитория, как это случилось бы с config.js.
  // stamp меняется при каждом прогоне: по нему часы понимают, что перед
  // ними новая сборка, и забывают адрес и токен прошлой установки,
  // сохранённые в @system.storage.
  const stamp = new Date().toISOString();
  const watchConfig = `// Сгенерировано \`npm run setup\` в server/ — не редактируйте вручную
// и не коммитьте: файл содержит токен устройства и указан в .gitignore.
// Чтобы обновить адрес или токен, перезапустите setup и пересоберите .rpk.
export var LOCAL = {
  gatewayUrl: ${JSON.stringify(gatewayUrl)},
  deviceToken: ${JSON.stringify(token)},
  stamp: ${JSON.stringify(stamp)}
}
`;
  await writeFile(WATCH_CONFIG_PATH, watchConfig, "utf8");

  // 6. Отчёт: всё, что человеку иначе пришлось бы выяснять самому.
  const lines = [];
  lines.push("");
  lines.push("TimeW готов к запуску.");
  lines.push("");
  lines.push(`  server/.env         ${created ? "создан из .env.example" : "обновлён"}`);
  lines.push(`  DEVICE_TOKEN        ${maskToken(token)} ${tokenIsNew ? "(сгенерирован)" : "(оставлен прежним)"}`);
  lines.push(`  шлюз слушает        ${host}:${port}${localhostOnly ? " (только эта машина)" : " (видна в домашней сети)"}`);
  lines.push(`  адрес для часов     ${gatewayUrl || "не определён"}`);
  lines.push(`  watch/src/common/config.local.js записан`);
  lines.push("");

  if (!gatewayUrl) {
    lines.push(localhostOnly
      ? "  Адрес для часов не задан: в режиме --localhost его даёт туннель."
      : "  Не удалось определить адрес машины в домашней сети.");
    lines.push("  Поднимите туннель (docs/deploy.md) и повторите с готовым адресом:");
    lines.push("    npm run setup -- --url https://ваш-адрес");
    lines.push("");
  }

  const aiKey = readEnvValue(env, "AI_API_KEY") || "";
  const aiProvider = readEnvValue(env, "AI_PROVIDER") || "mock";
  if (!aiKey || aiProvider === "mock") {
    lines.push("  Режим demo: AI отвечает заглушкой, распознавание выдаёт тестовый текст.");
    lines.push("  Для настоящих ответов впишите AI_PROVIDER и AI_API_KEY в server/.env.");
    lines.push("");
  }

  lines.push("Дальше (из корня репозитория):");
  lines.push("  npm start        — поднять шлюз");
  lines.push("  npm run smoke    — проверить все эндпоинты");
  lines.push("  npm run build    — собрать .rpk уже настроенным");
  lines.push("");
  console.log(lines.join("\n"));
}

main().catch((error) => {
  console.error(`Не удалось подготовить запуск: ${error.message}`);
  process.exit(1);
});
