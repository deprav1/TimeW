// Подставные системные модули Vela.
//
// Логика часов — обычный JS, но она импортирует @system.storage, @system.fetch
// и прочие модули, которых на обычном Node нет. Здесь они заменяются
// управляемыми заглушками, и сценарии приложения становятся проверяемыми без
// часов и без эмулятора: очередь, настройки, построение запросов, фолбэки.
//
// Заглушки нарочно воспроизводят повадки настоящего рантайма, на которых
// приложение уже обжигалось: колбэки вместо промисов, возможность вообще не
// ответить (молчащий модуль), ошибки с кодом во втором аргументе.

export const storage = {
  // Внутреннее состояние «диска» часов.
  data: {},
  failOnSet: false,
  failOnGet: false,

  get({ key, success, fail }) {
    if (storage.failOnGet) return void setTimeout(() => fail && fail({ message: "storage get failed" }), 0);
    // Настоящий storage отдаёт "" для незаданного ключа, а не undefined.
    setTimeout(() => success && success(storage.data[key] === undefined ? "" : storage.data[key]), 0);
  },

  set({ key, value, success, fail }) {
    if (storage.failOnSet) return void setTimeout(() => fail && fail({ message: "storage set failed" }), 0);
    storage.data[key] = String(value);
    setTimeout(() => success && success(), 0);
  },

  reset() {
    storage.data = {};
    storage.failOnSet = false;
    storage.failOnGet = false;
  }
};

export const network = {
  type: "wifi",
  silent: false,
  getType({ success, fail }) {
    if (network.silent) return;
    if (network.type === null) return void setTimeout(() => fail && fail({ message: "no network info" }), 0);
    setTimeout(() => success && success({ type: network.type }), 0);
  },
  reset() {
    network.type = "wifi";
    network.silent = false;
  }
};

export const fetchModule = {
  // Очередь ответов: каждый следующий вызов забирает первый элемент.
  // Элемент — либо { response }, либо { error }, либо { silent: true }.
  scripted: [],
  calls: [],
  throwOnCall: false,

  fetch(options) {
    fetchModule.calls.push(options);
    if (fetchModule.throwOnCall) throw new Error("fetch is not available");
    const next = fetchModule.scripted.shift() || { response: { code: 200, data: JSON.stringify({ ok: true }) } };
    if (next.silent) return;
    setTimeout(() => {
      if (next.error) options.fail && options.fail(next.error, next.error.code);
      else options.success && options.success(next.response);
    }, 0);
  },

  reset() {
    fetchModule.scripted = [];
    fetchModule.calls = [];
    fetchModule.throwOnCall = false;
  }
};

export const file = {
  files: {},
  silent: false,
  readArrayBuffer({ uri, success, fail }) {
    if (file.silent) return;
    const bytes = file.files[uri];
    if (bytes === undefined) return void setTimeout(() => fail && fail({ message: "file not found" }), 0);
    setTimeout(() => success && success({ buffer: bytes }), 0);
  },
  reset() {
    file.files = {};
    file.silent = false;
  }
};

// request.upload намеренно отсутствует: опрос реального рантайма показал,
// что метода нет. Тесты опираются на это, чтобы фолбэк проверялся всерьёз.
export const request = {
  download() {},
  onDownloadComplete() {}
};

export const prompt = {
  dialogs: [],
  answer: 0,
  silent: false,
  showDialog(options) {
    prompt.dialogs.push(options);
    if (prompt.silent) return;
    setTimeout(() => options.success && options.success({ index: prompt.answer }), 0);
  },
  showToast() {},
  reset() {
    prompt.dialogs = [];
    prompt.answer = 0;
    prompt.silent = false;
  }
};

export const record = {
  scripted: null,
  start(options) {
    const next = record.scripted;
    if (!next) return;
    setTimeout(() => {
      if (next.error) options.fail && options.fail(next.error, next.error.code);
      else options.success && options.success(next.result);
    }, 0);
  },
  stop() {},
  reset() {
    record.scripted = null;
  }
};

export const vibrator = { vibrate() {} };
export const router = { pushes: [], push(o) { router.pushes.push(o); }, back() {}, reset() { router.pushes = []; } };
export const audio = {};
export const media = {};

export function resetAll() {
  storage.reset();
  network.reset();
  fetchModule.reset();
  file.reset();
  prompt.reset();
  record.reset();
  router.reset();
}
