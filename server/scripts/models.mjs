// Какие модели доступны ключу и какая из них быстрее на нашем запросе.
//
//   npm run models            # список доступных моделей
//   npm run models -- --bench # замер задержки кандидатов (тратит запросы)
//
// Выбор модели — это про задержку, а не про номер версии: 3.8-flash
// оказалась быстрее 3.6-flash почти на секунду, а 2.5-pro-preview-tts —
// медленнее 3.1-flash-tts-preview. Проверять надо замером, поэтому скрипт
// лежит в репозитории, а не в чьей-то истории команд.
//
// Ключ берётся из server/.env и никуда не печатается.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

function apiKey() {
  try {
    const env = readFileSync(join(here, "..", ".env"), "utf8");
    const match = env.match(/^\s*(AI_API_KEY|GEMINI_API_KEY)\s*=\s*(.*?)\s*$/m);
    return match ? match[2] : "";
  } catch {
    return "";
  }
}

const key = process.env.AI_API_KEY || apiKey();
if (!key) {
  console.error("Ключ не найден: задайте AI_API_KEY в server/.env");
  process.exit(1);
}

const base = (process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com").replace(/\/$/, "");
const withKey = (path) => `${base}${path}${path.includes("?") ? "&" : "?"}key=${encodeURIComponent(key)}`;

const listed = await fetch(withKey("/v1beta/models?pageSize=200"));
if (!listed.ok) {
  console.error(`Список моделей не пришёл: ${listed.status} ${(await listed.text()).slice(0, 200)}`);
  process.exit(1);
}
const models = ((await listed.json()).models || []).map((model) => ({
  name: model.name.replace("models/", ""),
  methods: model.supportedGenerationMethods || []
}));

const answering = models.filter((m) => m.methods.includes("generateContent") && /^gemini-[\d.]+-(flash|pro)(-lite)?$/.test(m.name));
const speaking = models.filter((m) => /tts/.test(m.name));
const live = models.filter((m) => m.methods.includes("bidiGenerateContent"));

console.log(`Всего моделей: ${models.length}`);
console.log(`\nДля ответов (${answering.length}):`);
answering.forEach((m) => console.log("  " + m.name));
console.log(`\nДля озвучки (${speaking.length}):`);
speaking.forEach((m) => console.log("  " + m.name));
console.log(`\nПотоковые, требуют WebSocket и в шлюзе не используются (${live.length}):`);
live.forEach((m) => console.log("  " + m.name));

if (!process.argv.includes("--bench")) {
  console.log("\nЗамер задержки: npm run models -- --bench");
  process.exit(0);
}

const SYSTEM = "Отвечай по-русски одним-двумя короткими предложениями. Без markdown.";
const QUESTION = "Сколько лететь из Белграда до Лиссабона и нужна ли пересадка?";

async function timeAnswer(model) {
  const startedAt = Date.now();
  const res = await fetch(withKey(`/v1beta/models/${model}:generateContent`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: "user", parts: [{ text: QUESTION }] }],
      generationConfig: { maxOutputTokens: 220, temperature: 0.2, thinkingConfig: { thinkingBudget: 0 } }
    })
  });
  const ms = Date.now() - startedAt;
  if (!res.ok) return { ms, note: `отказ ${res.status}` };
  const body = await res.json();
  const text = (body.candidates?.[0]?.content?.parts || []).map((part) => part.text || "").join("").trim();
  return { ms, note: `${text.length} символов` };
}

async function timeSpeech(model) {
  const startedAt = Date.now();
  const res = await fetch(withKey(`/v1beta/models/${model}:generateContent`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: "Проверка звука. Часы слышат вас и отвечают голосом." }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } } }
      }
    })
  });
  const ms = Date.now() - startedAt;
  if (!res.ok) return { ms, note: `отказ ${res.status}` };
  const body = await res.json();
  const part = (body?.candidates?.[0]?.content?.parts || []).map((p) => p.inlineData || p.inline_data).find(Boolean);
  return { ms, note: part ? `${Buffer.from(part.data, "base64").length} байт` : "без аудио" };
}

console.log("\n=== задержка ответа (два прогона) ===");
for (const model of answering) {
  const runs = [await timeAnswer(model.name), await timeAnswer(model.name)];
  console.log(`  ${String(Math.round((runs[0].ms + runs[1].ms) / 2)).padStart(5)} мс  ${model.name}  (${runs.map((r) => r.ms + " мс, " + r.note).join(" | ")})`);
}

console.log("\n=== задержка озвучки ===");
for (const model of speaking) {
  const run = await timeSpeech(model.name);
  console.log(`  ${String(run.ms).padStart(5)} мс  ${model.name}  (${run.note})`);
}
