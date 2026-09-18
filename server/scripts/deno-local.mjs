// Локальный запуск шлюза под Deno — тем же рантаймом, что и на хосте.
//
// Смысл обёртки: выставить TIMEW_LOCAL=1. По этому признаку точка входа
// понимает, что слушать нужно наш порт, а не тот, который назначает
// платформа. Делать это строкой в package.json нельзя — синтаксис
// присваивания переменной несовместим между cmd и оболочками Unix.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const entry = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "deno-entry.mjs");

const result = spawnSync(
  "npx",
  ["--yes", "deno@latest", "run", "-A", "--unstable-kv", entry],
  { stdio: "inherit", shell: true, env: { ...process.env, TIMEW_LOCAL: "1" } }
);

process.exit(result.status === null ? 1 : result.status);
