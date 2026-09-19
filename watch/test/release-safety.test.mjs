// Правило публикации, которое нельзя забыть: токен устройства не должен
// оказаться ни в одном файле под контролем версий. Репозиторий публичный, а
// собранный RPK носит токен открытым текстом — так устроена конфигурация,
// потому что на часах нет ввода текста.
//
// Тест ничего не печатает из самого токена: только вердикт.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const watchRoot = join(dirname(fileURLToPath(new URL(import.meta.url))), "..");
const repoRoot = join(watchRoot, "..");
const localConfig = join(watchRoot, "src", "common", "config.local.js");

function deviceToken() {
  if (!existsSync(localConfig)) return "";
  const match = readFileSync(localConfig, "utf8").match(/deviceToken:\s*["']([^"']*)["']/);
  return match && match[1].length >= 12 ? match[1] : "";
}

test("токен устройства не попал ни в один отслеживаемый файл", () => {
  const token = deviceToken();
  if (!token) return; // Заглушка без токена — проверять нечего.

  const files = execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);

  const leaked = files.filter((file) => {
    try {
      return readFileSync(join(repoRoot, file)).toString("latin1").includes(token);
    } catch {
      return false;
    }
  });

  assert.deepEqual(leaked, [], "токен найден в файлах репозитория — смените его через `npm run setup`");
});

test("config.local.js и сборки остаются вне репозитория", () => {
  // Проверяем по одному: check-ignore с несколькими путями возвращает разный
  // код в зависимости от версии git, и «прошло» там ничего не доказывает.
  for (const path of ["watch/src/common/config.local.js", "watch/dist"]) {
    let ignored = true;
    try {
      execFileSync("git", ["check-ignore", "-q", path], { cwd: repoRoot });
    } catch {
      ignored = false;
    }
    assert.equal(ignored, true, `${path} обязан быть в .gitignore`);
  }
});
