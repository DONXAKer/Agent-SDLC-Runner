/**
 * «Сборка» проекта.
 *
 * Компиляции здесь нет: TypeScript исполняется напрямую, типы снимает сам Node. Поэтому
 * сборкой считается загрузка всех модулей пакета — она ловит то, что вообще может
 * сломаться без компилятора: синтаксис, недостающий файл, циклический импорт, падение
 * на верхнем уровне модуля.
 *
 * Версия Node проверяется первой и вслух. Снятие типов включено по умолчанию начиная с
 * 23.6; на более старой версии импорт `.ts` падает с невнятным «Unknown file extension»,
 * и без этой проверки такой отказ читался бы как дефект кода.
 *
 * `test/*.ts` тоже проверяются, но НЕ через `import()`, как `src/` — `node:test`
 * (`describe`/`it`) исполняет тело теста сразу при вызове, даже вне `node --test`
 * (проверено живым прогоном); импорт тестового файла тем самым запускал бы сами тесты, и
 * «Сборка» слилась бы с гейтом «Тесты». `node --check` для этого не годится — экспериментально
 * подтверждено, что на файле с `import` и расширением `.ts` он в этой версии Node СИНТАКСИС
 * НЕ проверяет и молча даёт `0`, даже на заведомо битом файле (в норме `--check` ловит то же
 * самое на `.mjs`, но не на ESM-`.ts`). Вместо него — `stripTypeScriptTypes` из `node:module`:
 * та же функция, что снимает типы при обычном исполнении `.ts`, парсит файл целиком и кидает
 * исключение на синтаксической ошибке, ничего не исполняя. Ловит ровно синтаксис (в т.ч.
 * осиротевший хвост от неполного SEARCH/REPLACE — живой случай: `cline_roocode:8b`, stepFill,
 * 2026-09-02, лишний `});` вне своего `describe`), но не недостающий файл и не циклический
 * импорт — этого без исполнения не увидеть.
 *
 * Выход — `process.exitCode`, а не `process.exit()`: с несколькими вызовами
 * `stripTypeScriptTypes` в одном процессе `process.exit()` падает на Windows нативным
 * ассертом libuv (`!(handle->flags & UV_HANDLE_CLOSING)`, `src\win\async.c`) — экспериментально
 * воспроизведено на этом самом наборе файлов. `exitCode` даёт процессу закрыться штатно и
 * ассерта не бьёт.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';

// `stripTypeScriptTypes` экспериментальна и об этом предупреждает при первом вызове —
// решение использовать её осознанное (см. докстринг файла), предупреждение не действие.
process.removeAllListeners('warning');

const MIN_NODE = [23, 6];

function versionProblem() {
  const parts = process.versions.node.split('.').map(Number);
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  if (major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1])) return null;
  return (
    `нужен Node ${MIN_NODE[0]}.${MIN_NODE[1]} или новее, запущен ${process.versions.node}: ` +
    'на более старом снятие типов выключено и импорт .ts не работает'
  );
}

async function main() {
  const problem = versionProblem();
  if (problem !== null) {
    console.error(`сборка невозможна: ${problem}`);
    process.exitCode = 1;
    return;
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const srcDir = resolve(here, '..', 'src');

  const modules = readdirSync(srcDir)
    .filter((name) => name.endsWith('.ts'))
    .sort();

  if (modules.length === 0) {
    console.error(`сборка невозможна: в ${srcDir} нет ни одного модуля`);
    process.exitCode = 1;
    return;
  }

  let failed = 0;
  for (const name of modules) {
    try {
      await import(pathToFileURL(join(srcDir, name)).href);
      console.log(`ok   ${name}`);
    } catch (e) {
      failed += 1;
      console.error(`ОШИБКА ${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const testDir = resolve(here, '..', 'test');
  let testModules = [];
  try {
    testModules = readdirSync(testDir)
      .filter((name) => name.endsWith('.ts'))
      .sort();
  } catch {
    testModules = []; // папки test нет — не повод валить сборку
  }

  // `stripTypeScriptTypes` появилась в `node:module` позже, чем сам порог MIN_NODE этого
  // файла — на версии без неё пропускаем проверку тестов с явной пометкой, а не падаем
  // непонятной ошибкой «не функция».
  if (testModules.length > 0 && typeof stripTypeScriptTypes !== 'function') {
    console.log(`test/*.ts: пропущено — node:module.stripTypeScriptTypes недоступна на ${process.versions.node}`);
  } else {
    for (const name of testModules) {
      try {
        stripTypeScriptTypes(readFileSync(join(testDir, name), 'utf8'), { mode: 'strip' });
        console.log(`ok   test/${name}`);
      } catch (e) {
        failed += 1;
        console.error(`ОШИБКА test/${name}: синтаксис не разобран — ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  const total = modules.length + testModules.length;
  console.log(`модулей загружено: ${total - failed} из ${total}`);
  process.exitCode = failed === 0 ? 0 : 1;
}

await main();
