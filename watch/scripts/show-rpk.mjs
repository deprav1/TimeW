// После сборки печатает путь к свежему .rpk — файлу, который нужно указать
// в Mi Fitness. Иначе его приходится искать по каталогам сборки вручную.
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const WATCH_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

function findRpk(dir, found) {
  if (!existsSync(dir)) return found;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) findRpk(full, found);
    else if (entry.name.endsWith(".rpk")) found.push({ path: full, mtime: statSync(full).mtimeMs });
  }
  return found;
}

const candidates = [];
for (const dir of ["dist", "build"]) findRpk(join(WATCH_DIR, dir), candidates);
candidates.sort((a, b) => b.mtime - a.mtime);

if (candidates.length) {
  console.log("");
  console.log(`Готов к установке: ${candidates[0].path}`);
  console.log("Mi Fitness → Я → О программе → Отладка → Установить стороннее приложение");
  console.log("");
}
