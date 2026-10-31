/**
 * Гейт «Типы» — компилируемость/типы без сборки артефактов.
 *
 * Проверяется та же честная тройка исходов, что у линта: типчекера у экосистемы нет или
 * он неприменим к каталогу → ⏭ с прямой формулировкой, а не ❌ и не поддельный ✅;
 * override из конфига проекта исполняется через шелл и даёт ✅/❌ по коду выхода.
 * Смешивать «инструмента нет» с «код плохой» нельзя — красный по первой причине обучает
 * игнорировать гейт.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { match, ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

const okCommand = process.platform === 'win32' ? 'ver' : 'true';
const failCommand = process.platform === 'win32' ? 'where.exe __sdlc_runner_missing__' : 'false';

import { BUILTIN } from '../src/gates/builtin/index.ts';
import type { GateContext } from '../src/gates/builtin/index.ts';
import type { ModuleProfile } from '../src/config/schema.ts';

/**
 * Фикстура — каталог модуля с файлами, объявленный в конфиге проекта. git не нужен:
 * типчек, в отличие от линта, работает на модуль целиком и список изменений не читает.
 */
function project(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sdlc-types-')));
  mkdirSync(join(root, 'api'), { recursive: true });
  writeFileSync(join(root, 'api', 'main.go'), 'package main\n');
  return root;
}

function ctx(root: string, modules: ModuleProfile[]): GateContext {
  return {
    projectRoot: root,
    planFiles: ['api/main.go'],
    baseline: null,
    timeoutMs: 5_000,
    modules,
  };
}

function hasTool(cmd: string): boolean {
  try {
    execFileSync(cmd, ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('гейт типов', () => {
  const gate = BUILTIN.get('типы');

  it('зарегистрирован в реестре встроенных', () => {
    ok(gate !== undefined);
  });

  it('экосистема без типчекера — ⏭ с названной причиной, а не ❌', async () => {
    ok(gate !== undefined);
    const root = project();
    // У JVM типчекера без сборки нет: выдумывать его нельзя, но и молчать тоже.
    const outcome = await gate(ctx(root, [{ dir: 'api', ecosystem: 'maven', build: 'true' }]));
    strictEqual(outcome.status, '⏭');
    match(outcome.lastLine, /типчекера нет|НЕ проверялась/);
  });

  it('node-проект без tsconfig — типчекер неприменим, ⏭ с объяснением', async () => {
    ok(gate !== undefined);
    const root = project();
    const outcome = await gate(ctx(root, [{ dir: 'api', ecosystem: 'node', build: 'true' }]));
    strictEqual(outcome.status, '⏭');
    match(outcome.lastLine, /неприменим|НЕ проверялись/);
  });

  it('override из конфига: чистый прогон даёт ✅', async () => {
    ok(gate !== undefined);
    const root = project();
    const outcome = await gate(
      ctx(root, [{ dir: 'api', build: okCommand, typecheck: okCommand }]),
    );
    strictEqual(outcome.status, '✅');
  });

  it('override из конфига: ошибки типов дают ❌, а не пропуск', async () => {
    ok(gate !== undefined);
    const root = project();
    const outcome = await gate(
      ctx(root, [{ dir: 'api', build: okCommand, typecheck: failCommand }]),
    );
    strictEqual(outcome.status, '❌');
  });

  it('типчекер не установлен на машине — ⏭ и прямая формулировка', async (t) => {
    ok(gate !== undefined);
    // `cargo check` — единственный пресет без npx-обёртки, которого может не быть на
    // машине разработчика; если cargo стоит, случай «нет инструмента» здесь не
    // воспроизвести, и тест честно пропускается, а не краснеет по чужой причине.
    if (hasTool('cargo')) {
      t.skip('cargo установлен — случай «инструмента нет» не воспроизводится');
      return;
    }
    const root = project();
    const outcome = await gate(ctx(root, [{ dir: 'api', ecosystem: 'cargo', build: 'true' }]));
    strictEqual(outcome.status, '⏭');
    match(outcome.lastLine, /не найден|НЕ проверялись/);
  });
});
