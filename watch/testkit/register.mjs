// Подключается через `node --import`, включает загрузчик для всех тестов.
import { registerHooks } from "node:module";
import { load, resolve } from "./loader.mjs";

registerHooks({ resolve, load });
