// Имена здесь должны совпадать с суффиксами @system.*: импорт
// "@system.storage" загрузчик превращает в `export { storage as default }`.
export {
  storage,
  network,
  file,
  request,
  uploadtask,
  prompt,
  record,
  vibrator,
  router,
  audio,
  volume,
  media
} from "./system.mjs";

export { fetchModule as fetch } from "./system.mjs";
