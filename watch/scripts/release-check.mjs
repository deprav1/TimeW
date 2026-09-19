// Проверка перед публикацией: не утёк ли токен устройства в репозиторий.
//
// Собранный RPK содержит адрес шлюза и токен открытым текстом — иначе часы не
// смогут никуда постучаться, ввода текста в рантайме Vela нет. Репозиторий
// публичный, поэтому единственная защита — чтобы ни один файл под контролем
// версий и ни один артефакт сборки не попал в коммит вместе с токеном.
//
// Скрипт ничего не печатает из самого токена: только длину и вердикт.

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const watchRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(watchRoot, "..");
const localConfig = join(watchRoot, "src", "common", "config.local.js");

function secrets() {
  if (!existsSync(localConfig)) return [];
  const source = readFileSync(localConfig, "utf8");
  const found = [];
  const token = source.match(/deviceToken:\s*["']([^"']*)["']/);
  // Короткие и пустые значения не считаем секретом: у незаполненной заглушки
  // deviceToken пустой, и поиск по пустой строке совпал бы со всем подряд.
  if (token && token[1].length >= 12) found.push({ name: "deviceToken", value: token[1] });
  return found;
}

function trackedFiles() {
  const out = execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "utf8" });
  return out.split("\0").filter(Boolean);
}

function main() {
  const found = secrets();
  if (!found.length) {
    console.log("release:check — config.local.js без токена, проверять нечего.");
    console.log("Сборка получится нейтральной: на часах будет «Шлюз не настроен».");
    return;
  }

  const leaked = [];
  for (const file of trackedFiles()) {
    const path = join(repoRoot, file);
    let content;
    try {
      content = readFileSync(path);
    } catch {
      continue;
    }
    const text = content.toString("latin1");
    for (const secret of found) {
      if (text.includes(secret.value)) leaked.push(`${file} (${secret.name})`);
    }
  }

  for (const secret of found) {
    console.log(`release:check — ${secret.name} задан, длина ${secret.value.length}.`);
  }

  if (leaked.length) {
    console.error("");
    console.error("ОСТАНОВКА: токен найден в файлах под контролем версий:");
    for (const item of leaked) console.error("  - " + item);
    console.error("");
    console.error("Репозиторий публичный. Уберите файл из индекса и смените токен:");
    console.error("  cd server && npm run setup");
    process.exit(1);
  }

  console.log("release:check — в отслеживаемых файлах токена нет.");
  console.log("Сборка в dist/ персональная: публиковать её нельзя, см. docs/release.md.");
}

main();
