// Готовит сборку часов. Запускается сам из prebuild/prestart, руками звать
// не нужно.
//
// 1. config.local.js. Адрес шлюза и токен в git не хранятся, а сборщик Vela
//    разрешает импорты статически — отсутствующий файл уронил бы сборку у
//    любого, кто ещё не запускал `npm run setup`. Создаём заглушку: сборка
//    проходит, приложение само говорит, что шлюз не настроен.
//
// 2. versionCode (только при --bump). Часы отказываются обновлять приложение,
//    если номер не вырос, и делают это молча: установка «проходит», а на
//    устройстве остаётся старая сборка. Ручной шаг, который легко забыть и
//    невозможно заметить, поэтому считает машина.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const WATCH_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = join(WATCH_DIR, "src", "common", "config.local.js");
const buildInfoPath = join(WATCH_DIR, "src", "common", "build-info.js");
const manifestPath = join(WATCH_DIR, "src", "manifest.json");

if (!existsSync(configPath)) {
  writeFileSync(configPath, `// Заглушка: адрес шлюза и токен ещё не заданы.
// Заполняется командой \`npm run setup\` в корне репозитория.
export var LOCAL = {}
`, "utf8");
  console.log("config.local.js не найден — создана заглушка. Запустите `npm run setup`, чтобы прописать адрес и токен.");
}

// Номер сборки нужен и самому приложению: по нему видно, что установлено
// на часах. Метка из config.local.js для этого не годится — она меняется
// только при setup, а сборок между ними бывает несколько.
function writeBuildInfo(versionCode) {
  writeFileSync(buildInfoPath, `// Генерируется сборкой. В git не хранится.
export var VERSION_CODE = ${versionCode}
`, "utf8");
}

if (!existsSync(buildInfoPath)) writeBuildInfo(0);

if (process.argv.includes("--bump")) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.versionCode = Number(manifest.versionCode || 0) + 1;
  // Записываем с тем же отступом, что и в файле, чтобы автоматический
  // инкремент не создавал шумную диффу на весь манифест.
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  writeBuildInfo(manifest.versionCode);
  console.log(`versionCode → ${manifest.versionCode}`);
}
