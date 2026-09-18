// Точка входа для Deno Deploy.
//
// Сборщик Deploy ищет entrypoint с привычным именем и расширением, поэтому
// вся логика остаётся в server/src/deno-entry.mjs, а этот файл — тонкая
// обёртка, которая её подключает.
import "./server/src/deno-entry.mjs";
