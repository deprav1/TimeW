// Загрузчик модулей для тестов часов.
//
// Делает две вещи, без которых код часов на Node не запускается:
//
// 1. Импорты вида "@system.storage" разрешает в заглушки из system.mjs.
//    На устройстве их предоставляет рантайм Vela, в репозитории их нет.
//
// 2. Заставляет Node считать файлы watch/src ES-модулями. В watch/package.json
//    нет "type": "module" (и добавлять его нельзя — это сборка часов, а не
//    Node-пакет), поэтому по умолчанию Node принял бы .js за CommonJS и упал
//    бы на первом же import.
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = pathToFileURL(join(HERE, "..", "src")).href;
const EXPORTS = pathToFileURL(join(HERE, "system-exports.mjs")).href;
const VIRTUAL = "timew-system:";

export function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@system.")) {
    return { url: VIRTUAL + specifier.slice("@system.".length), shortCircuit: true };
  }
  // Код часов пишет `from "./config"` без расширения: сборщик Vela так умеет,
  // Node — нет. Дописываем .js для относительных импортов внутри watch/src.
  const parent = context.parentURL || "";
  const relative = specifier.startsWith("./") || specifier.startsWith("../");
  // Проверяем именно известные расширения, а не «точка в конце пути»:
  // иначе "./config.local" принимается за файл с расширением .local.
  if (relative && parent.startsWith(SRC) && !/\.(js|mjs|cjs|json)$/i.test(specifier)) {
    return nextResolve(`${specifier}.js`, context);
  }
  return nextResolve(specifier, context);
}

export function load(url, context, nextLoad) {
  if (url.startsWith(VIRTUAL)) {
    const name = url.slice(VIRTUAL.length);
    return {
      format: "module",
      shortCircuit: true,
      source: `export { ${name} as default } from ${JSON.stringify(EXPORTS)};`
    };
  }
  if (url.startsWith(SRC) && url.endsWith(".js")) {
    return { format: "module", shortCircuit: true, source: readFileSync(fileURLToPath(url), "utf8") };
  }
  return nextLoad(url, context);
}
