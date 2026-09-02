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
 */

import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

const problem = versionProblem();
if (problem !== null) {
  console.error(`сборка невозможна: ${problem}`);
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(here, '..', 'src');

const modules = readdirSync(srcDir)
  .filter((name) => name.endsWith('.ts'))
  .sort();

if (modules.length === 0) {
  console.error(`сборка невозможна: в ${srcDir} нет ни одного модуля`);
  process.exit(1);
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

console.log(`модулей загружено: ${modules.length - failed} из ${modules.length}`);
process.exit(failed === 0 ? 0 : 1);
