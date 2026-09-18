// Сценарии офлайн-очереди — того, что происходит с заметкой, когда сети нет.
// На часах без eSIM это не редкий случай, а обычный режим вне дома.
import test from "node:test";
import assert from "node:assert/strict";
import { storage, resetAll } from "../testkit/system.mjs";

const {
  loadQueue,
  getQueued,
  enqueue,
  enqueueAudio,
  flush
} = await import("../src/common/queue.js");

function fresh() {
  resetAll();
  return new Promise((resolve) => loadQueue(resolve));
}

test("надиктованная без сети заметка сохраняется вместе со звуком", async () => {
  await fresh();
  await new Promise((done, fail) => enqueueAudio("internal://cache/a.opus", "audio/opus", done, fail));
  const queued = getQueued();
  assert.equal(queued.length, 1);
  assert.equal(queued[0].kind, "audio");
  assert.equal(queued[0].uri, "internal://cache/a.opus");
  assert.ok(queued[0].requestId, "нужен ключ идемпотентности, иначе досылка создаст дубль");
});

test("очередь переживает перезапуск приложения", async () => {
  await fresh();
  await new Promise((done) => enqueueAudio("internal://cache/a.opus", "audio/opus", done));
  // Перезапуск: кэш модуля сбрасывается, storage остаётся.
  await new Promise((resolve) => loadQueue(resolve));
  assert.equal(getQueued().length, 1);
});

test("если storage не принял запись, очередь не врёт об успехе", async () => {
  await fresh();
  storage.failOnSet = true;
  const error = await new Promise((resolve) => {
    enqueueAudio("internal://cache/a.opus", "audio/opus", () => resolve(null), resolve);
  });
  assert.ok(error, "ожидалась ошибка, а не тихий успех");
  assert.equal(getQueued().length, 0, "кэш должен откатиться, иначе счётчик покажет несуществующую заметку");
});

test("протухшая запись не всплывает через неделю", async () => {
  await fresh();
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  storage.data.pendingNotes = JSON.stringify([
    { id: "1", kind: "audio", uri: "internal://cache/old.opus", createdAt: old },
    { id: "2", kind: "audio", uri: "internal://cache/new.opus", createdAt: new Date().toISOString() }
  ]);
  await new Promise((resolve) => loadQueue(resolve));
  const queued = getQueued();
  assert.equal(queued.length, 1);
  assert.equal(queued[0].uri, "internal://cache/new.opus");
});

test("заметки из старой версии приложения не теряются при обновлении", async () => {
  await fresh();
  // В прошлой версии элементы лежали без поля kind.
  storage.data.pendingNotes = JSON.stringify([{ id: "1", text: "купить фильтр", createdAt: new Date().toISOString() }]);
  await new Promise((resolve) => loadQueue(resolve));
  assert.equal(getQueued().length, 1);
  assert.equal(getQueued()[0].kind, "text");
});

test("успешная досылка убирает заметку из очереди", async () => {
  await fresh();
  await new Promise((done) => enqueue("купить фильтр", done));
  const result = await new Promise((resolve) => {
    flush((item, onOk) => onOk(), (sent, left, dropped) => resolve({ sent, left, dropped }));
  });
  assert.deepEqual(result, { sent: 1, left: 0, dropped: 0 });
  assert.equal(getQueued().length, 0);
});

test("неудачная досылка сохраняет заметку до следующего раза", async () => {
  await fresh();
  await new Promise((done) => enqueue("купить фильтр", done));
  const result = await new Promise((resolve) => {
    flush((item, onOk, onErr) => onErr(), (sent, left) => resolve({ sent, left }));
  });
  assert.deepEqual(result, { sent: 0, left: 1 });
  assert.equal(getQueued().length, 1, "заметка обязана пережить неудачу — иначе она потеряна навсегда");
});

test("пропавший файл записи не блокирует очередь навсегда", async () => {
  await fresh();
  await new Promise((done) => enqueueAudio("internal://cache/gone.opus", "audio/opus", done));
  await new Promise((done) => enqueue("вторая заметка", done));

  const result = await new Promise((resolve) => {
    flush((item, onOk, onErr, onDrop) => {
      if (item.kind === "audio") onDrop();
      else onOk();
    }, (sent, left, dropped) => resolve({ sent, left, dropped }));
  });

  assert.equal(result.dropped, 1);
  assert.equal(result.sent, 1, "то, что стоит за потерянным файлом, должно уйти");
  assert.equal(getQueued().length, 0);
});

test("две одновременные досылки не отправляют одну заметку дважды", async () => {
  await fresh();
  await new Promise((done) => enqueue("купить фильтр", done));

  let sendCalls = 0;
  const first = new Promise((resolve) => {
    flush((item, onOk) => {
      sendCalls += 1;
      setTimeout(onOk, 10);
    }, (sent) => resolve(sent));
  });
  const second = await new Promise((resolve) => {
    flush(() => assert.fail("вторая досылка не должна трогать очередь"), (sent) => resolve(sent));
  });

  assert.equal(second, 0);
  assert.equal(await first, 1);
  assert.equal(sendCalls, 1);
});

test("очередь не растёт бесконечно", async () => {
  await fresh();
  for (let i = 0; i < 55; i += 1) {
    await new Promise((done) => enqueue(`заметка ${i}`, done));
  }
  assert.equal(getQueued().length, 50);
  assert.equal(getQueued()[0].text, "заметка 5", "вытесняться должны самые старые");
});
