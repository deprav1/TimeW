// Шлюз должен подниматься сам. Пока он запускается вручную из терминала,
// любая перезагрузка = часы молча перестают работать, причём выглядит это
// как «Нет связи со шлюзом» — то же сообщение, что и при неверном адресе.
//
//   npm run autostart            # поднимать при входе в систему
//   npm run autostart -- --off   # убрать автозапуск
//   npm run autostart -- --status
//
// На Windows заводится задача планировщика, на Linux печатается готовый
// unit для systemd (там установка требует root, поэтому решает человек).
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(SERVER_DIR, "src", "server.mjs");
const node = process.execPath;
const TASK = "TimeW Gateway";

const args = process.argv.slice(2);
const remove = args.includes("--off") || args.includes("--remove");
const status = args.includes("--status");

function schtasks(params) {
  return execFileSync("schtasks", params, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function windows() {
  if (status) {
    try {
      schtasks(["/Query", "/TN", TASK]);
      console.log(`Автозапуск включён: задача «${TASK}» зарегистрирована.`);
    } catch {
      console.log("Автозапуск выключен. Включить: npm run autostart");
    }
    return;
  }

  if (remove) {
    try {
      schtasks(["/Delete", "/TN", TASK, "/F"]);
      console.log(`Автозапуск выключен, задача «${TASK}» удалена.`);
    } catch {
      console.log("Автозапуск и так не был включён.");
    }
    return;
  }

  // /RL LIMITED — задача идёт с обычными правами: шлюзу не нужен админ, а
  // постоянно висящий процесс с повышенными правами — лишний риск.
  schtasks([
    "/Create", "/TN", TASK,
    "/TR", `"${node}" "${entry}"`,
    "/SC", "ONLOGON",
    "/RL", "LIMITED",
    "/F"
  ]);
  console.log("");
  console.log(`Автозапуск включён: шлюз поднимается при входе в систему.`);
  console.log(`  задача       ${TASK}`);
  console.log(`  команда      ${node} ${entry}`);
  console.log("");
  console.log("  запустить сейчас, не перезаходя:  schtasks /Run /TN \"TimeW Gateway\"");
  console.log("  проверить:                        npm run autostart -- --status");
  console.log("  выключить:                        npm run autostart -- --off");
  console.log("");
  console.log("Компьютер в спящем режиме шлюз не обслуживает — для круглосуточной");
  console.log("доступности нужен VPS, см. docs/deploy.md.");
  console.log("");
}

function unixHint() {
  console.log("");
  console.log("На этой системе автозапуск ставится через systemd и требует root,");
  console.log("поэтому шаг делается вручную. Готовый unit с вашими путями:");
  console.log("");
  console.log("  /etc/systemd/system/timew.service");
  console.log("");
  console.log("[Unit]");
  console.log("Description=TimeW gateway");
  console.log("After=network-online.target");
  console.log("");
  console.log("[Service]");
  console.log("Type=simple");
  console.log(`WorkingDirectory=${SERVER_DIR}`);
  console.log(`ExecStart=${node} ${entry}`);
  console.log("Restart=always");
  console.log("RestartSec=5");
  console.log("");
  console.log("[Install]");
  console.log("WantedBy=multi-user.target");
  console.log("");
  console.log("  sudo systemctl enable --now timew");
  console.log("");
}

try {
  if (process.platform === "win32") windows();
  else unixHint();
} catch (error) {
  console.error(`Не удалось настроить автозапуск: ${error.message}`);
  process.exit(1);
}
