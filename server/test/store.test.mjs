// Проверка обоих хранилищ на одном наборе сценариев.
//
// Смысл теста: шлюз не должен вести себя по-разному в зависимости от того,
// где запущен. Поэтому оба хранилища прогоняются через одни и те же
// требования — и файловое (домашний компьютер, VPS), и KV (бесплатный хост).
//
// KV здесь поддельный, но с той же семантикой, что у Deno KV: составные
// ключи, entry.value и настоящий expireIn. Это проверяет нашу обёртку, а не
// чужую реализацию.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { createFileStore, createKvStore } = await import("../src/store.mjs");

// Поддельный Deno KV: хватает того, чем пользуется store.mjs.
function fakeKv() {
  const data = new Map();
  const encode = (key) => JSON.stringify(key);
  const alive = (entry) => !entry.expiresAt || Date.now() < entry.expiresAt;
  return {
    async get(key) {
      const entry = data.get(encode(key));
      if (!entry || !alive(entry)) return { key, value: null };
      return { key, value: entry.value };
    },
    async set(key, value, options) {
      data.set(encode(key), { value, expiresAt: options?.expireIn ? Date.now() + options.expireIn : 0 });
    },
    async delete(key) {
      data.delete(encode(key));
    },
    async *list({ prefix }) {
      for (const [encoded, entry] of data) {
        const key = JSON.parse(encoded);
        if (!alive(entry)) continue;
        if (prefix.every((part, i) => key[i] === part)) yield { key, value: entry.value };
      }
    }
  };
}

async function makeStores() {
  const dir = await mkdtemp(join(tmpdir(), "timew-store-"));
  return {
    dir,
    stores: [
      ["файловое", createFileStore(dir)],
      ["KV", createKvStore(fakeKv())]
    ]
  };
}

test("заметки сохраняются и читаются в обоих хранилищах", async () => {
  const { dir, stores } = await makeStores();
  try {
    for (const [name, store] of stores) {
      assert.deepEqual(await store.loadNotes(), [], `${name}: на пустом месте ожидался пустой список`);
      await store.saveNotes([{ id: "1", text: "купить фильтр" }]);
      const notes = await store.loadNotes();
      assert.equal(notes.length, 1, name);
      assert.equal(notes[0].text, "купить фильтр", name);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("список заметок ограничен сверху в обоих хранилищах", async () => {
  const { dir, stores } = await makeStores();
  try {
    const many = [];
    for (let i = 0; i < 80; i += 1) many.push({ id: String(i), text: `заметка ${i}` });
    for (const [name, store] of stores) {
      await store.saveNotes(many);
      assert.equal((await store.loadNotes()).length, 50, name);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ключ со сроком годности исчезает сам в обоих хранилищах", async () => {
  const { dir, stores } = await makeStores();
  try {
    for (const [name, store] of stores) {
      await store.kvSet("idem:x", { fingerprint: "a" }, 20);
      assert.ok(await store.kvGet("idem:x"), name);
      await new Promise((resolve) => setTimeout(resolve, 40));
      assert.equal(await store.kvGet("idem:x"), null, `${name}: просроченный ключ обязан исчезнуть`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("удаление и очистка по префиксу работают одинаково", async () => {
  const { dir, stores } = await makeStores();
  try {
    for (const [name, store] of stores) {
      await store.kvSet("idem:a", 1);
      await store.kvSet("idem:b", 2);
      await store.kvSet("speech:c", 3);

      await store.kvDelete("idem:a");
      assert.equal(await store.kvGet("idem:a"), null, name);
      assert.equal(await store.kvCount("idem:"), 1, name);

      await store.kvClear("idem:");
      assert.equal(await store.kvCount("idem:"), 0, name);
      assert.equal(await store.kvGet("speech:c"), 3, `${name}: чужой префикс трогать нельзя`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("повреждённые заметки изолируются, а не роняют список", async () => {
  const { dir, stores } = await makeStores();
  try {
    // Файловое хранилище: битый JSON на диске.
    const [, fileStore] = stores[0];
    await fileStore.saveNotes([{ id: "1", text: "цела" }]);
    await writeFile(join(dir, "notes.json"), "{ это не json", "utf8");
    assert.deepEqual(await fileStore.loadNotes(), [], "битый файл не должен ронять чтение");

    // KV: вместо списка лежит что-то другое.
    const kv = fakeKv();
    await kv.set(["timew", "notes"], { "не": "список" });
    const kvStore = createKvStore(kv);
    assert.deepEqual(await kvStore.loadNotes(), [], "битое значение в KV не должно ронять чтение");
    await kvStore.saveNotes([{ id: "2", text: "после изоляции" }]);
    assert.equal((await kvStore.loadNotes())[0].text, "после изоляции");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("запись заметок в файл атомарна: временный файл не остаётся", async () => {
  const dir = await mkdtemp(join(tmpdir(), "timew-store-"));
  try {
    const store = createFileStore(dir);
    await store.saveNotes([{ id: "1", text: "заметка" }]);
    await assert.rejects(() => readFile(join(dir, "notes.json.tmp"), "utf8"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
