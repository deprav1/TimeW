// Хранилище состояния шлюза.
//
// Пока шлюз жил на одной машине, состояние могло лежать где угодно: заметки
// в файле, короткоживущие ключи в памяти процесса. На бесплатных хостах
// (Deno Deploy, Vercel и подобные) между запросами нет ни того, ни другого —
// каждый запрос может прийти в свежий экземпляр. Тогда молча ломается ровно
// то, от чего зависит корректность:
//
//   - заметки просто исчезают;
//   - ключи идемпотентности теряются, и обрыв связи создаёт дубль заметки;
//   - токены подтверждения теряются, и «Выполнить» для умного дома не
//     срабатывает никогда;
//   - история разговора теряется, и «Ещё вопрос» каждый раз начинает с нуля.
//
// Поэтому всё это вынесено сюда за один узкий интерфейс, а место хранения
// выбирается при запуске. Ограничение частоты запросов сознательно оставлено
// в памяти: на нескольких экземплярах оно станет приблизительным, но это
// защита от перегрузки, а не от потери данных.
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";

export const NOTES_LIMIT = 50;

// --- Хранилище для одной машины: заметки в файле, остальное в памяти --------
//
// Это ровно прежнее поведение шлюза. Режим по умолчанию: локальный запуск,
// домашний компьютер, VPS — везде, где процесс живёт долго и у него есть диск.
export function createFileStore(dataDir) {
  const notesPath = join(dataDir, "notes.json");
  const kv = new Map();

  async function loadNotes() {
    let raw;
    try {
      raw = await readFile(notesPath, "utf8");
    } catch (cause) {
      if (cause.code !== "ENOENT") throw cause;
      return [];
    }
    try {
      return JSON.parse(raw);
    } catch (cause) {
      // Повреждённый файл не удаляем, а отодвигаем в сторону: содержимое
      // может пригодиться, а список заметок должен продолжить работать.
      console.error(`[${new Date().toISOString()}] notes.json повреждён, изолирую файл: ${cause.message}`);
      try {
        await rename(notesPath, `${notesPath}.corrupt.${Date.now()}`);
      } catch (renameCause) {
        console.error(`[${new Date().toISOString()}] не удалось изолировать повреждённый notes.json: ${renameCause.message}`);
      }
      return [];
    }
  }

  // Запись атомарная: сначала во временный файл, потом переименование.
  // Иначе перезапуск в момент сохранения оставил бы обрезанный JSON.
  async function saveNotes(notes) {
    await mkdir(dataDir, { recursive: true });
    const tmpPath = `${notesPath}.tmp`;
    await writeFile(tmpPath, JSON.stringify(notes.slice(0, NOTES_LIMIT), null, 2) + "\n", "utf8");
    await rename(tmpPath, notesPath);
  }

  // Срок годности проверяется при чтении, а не по таймеру: лишний таймер
  // удерживал бы процесс (и тесты) живым без причины.
  async function kvGet(key) {
    const hit = kv.get(key);
    if (!hit) return null;
    if (hit.expiresAt && Date.now() > hit.expiresAt) {
      kv.delete(key);
      return null;
    }
    return hit.value;
  }

  async function kvSet(key, value, ttlMs) {
    kv.set(key, { value, expiresAt: ttlMs ? Date.now() + ttlMs : 0 });
  }

  async function kvDelete(key) {
    kv.delete(key);
  }

  async function kvClear(prefix) {
    for (const key of Array.from(kv.keys())) {
      if (!prefix || key.startsWith(prefix)) kv.delete(key);
    }
  }

  // Сколько ключей с этим префиксом живо. Нужно только для ограничения
  // размера: на KV перебор дорогой, поэтому в интерфейсе это отдельный метод.
  async function kvCount(prefix) {
    let count = 0;
    for (const key of kv.keys()) if (key.startsWith(prefix)) count += 1;
    return count;
  }

  async function kvOldest(prefix) {
    for (const key of kv.keys()) if (key.startsWith(prefix)) return key;
    return null;
  }

  return { kind: "file", loadNotes, saveNotes, kvGet, kvSet, kvDelete, kvClear, kvCount, kvOldest };
}

// --- Хранилище для Deno Deploy: всё в Deno KV -------------------------------
//
// Тот же интерфейс поверх встроенного KV. Срок годности здесь настоящий
// (expireIn), поэтому просроченные ключи исчезают сами.
//
// Функция принимает уже открытое соединение: открывать его умеет только
// рантайм Deno, и импортировать Deno-специфичное в общий код нельзя —
// на обычном Node этот файл должен читаться без ошибок.
export function createKvStore(kv) {
  const NOTES_KEY = ["timew", "notes"];
  const key = (name) => ["timew", "kv", name];

  async function loadNotes() {
    const entry = await kv.get(NOTES_KEY);
    const value = entry && entry.value;
    if (!value) return [];
    if (Object.prototype.toString.call(value) !== "[object Array]") {
      // Аналог изоляции повреждённого файла: отодвигаем и продолжаем.
      console.error(`[${new Date().toISOString()}] заметки в KV повреждены, изолирую`);
      await kv.set(["timew", "notes-corrupt", Date.now()], value);
      await kv.delete(NOTES_KEY);
      return [];
    }
    return value;
  }

  async function saveNotes(notes) {
    await kv.set(NOTES_KEY, notes.slice(0, NOTES_LIMIT));
  }

  async function kvGet(name) {
    const entry = await kv.get(key(name));
    return entry && entry.value !== null && entry.value !== undefined ? entry.value : null;
  }

  async function kvSet(name, value, ttlMs) {
    await kv.set(key(name), value, ttlMs ? { expireIn: ttlMs } : undefined);
  }

  async function kvDelete(name) {
    await kv.delete(key(name));
  }

  async function kvClear(prefix) {
    for await (const entry of kv.list({ prefix: ["timew", "kv"] })) {
      const name = entry.key[entry.key.length - 1];
      if (!prefix || String(name).startsWith(prefix)) await kv.delete(entry.key);
    }
  }

  async function kvCount(prefix) {
    let count = 0;
    for await (const entry of kv.list({ prefix: ["timew", "kv"] })) {
      if (String(entry.key[entry.key.length - 1]).startsWith(prefix)) count += 1;
    }
    return count;
  }

  async function kvOldest(prefix) {
    for await (const entry of kv.list({ prefix: ["timew", "kv"] })) {
      const name = String(entry.key[entry.key.length - 1]);
      if (name.startsWith(prefix)) return name;
    }
    return null;
  }

  return { kind: "kv", loadNotes, saveNotes, kvGet, kvSet, kvDelete, kvClear, kvCount, kvOldest };
}
