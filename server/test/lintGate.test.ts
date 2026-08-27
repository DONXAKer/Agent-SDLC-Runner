/**
 * Гейт «Линт экосистемы».
 *
 * Проверяется различение трёх исходов: линтера нет на машине, линтер нашёл нарушения,
 * чисто. Смешивать первый со вторым нельзя — «инструмент не установлен» это не «код
 * плохой», и красный по такой причине обучает игнорировать гейт.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { match, ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BUILTIN } from '../src/gates/builtin/index.ts';
import type { GateContext } from '../src/gates/builtin/index.ts';
import type { ModuleProfile } from '../src/config/schema.ts';

/**
 * Фикстура — настоящий git-репозиторий: гейт линтует ИЗМЕНЁННЫЕ файлы, а список изменений
 * даёт git. В каталоге без git список пуст, и гейт честно отвечает «линтовать нечего» —
 * это верное поведение, но проверять на нём нечего.
 */
function repo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sdlc-lint-')));
  mkdirSync(join(root, 'api'), { recursive: true });
  writeFileSync(join(root, 'api', 'main.go'), 'package main\n');
  execFileSync('git', ['init', '-q'], { cwd: root });
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

describe('гейт линта экосистемы', () => {
  const lint = BUILTIN.get('линт экосистемы');

  it('зарегистрирован в реестре встроенных', () => {
    ok(lint !== undefined);
  });

  it('линтер не установлен — ⏭ и прямая формулировка, а не ❌', async () => {
    ok(lint !== undefined);
    const root = repo();
    // `golangci-lint` на машине заведомо нет: это и есть проверяемый случай.
    const outcome = await lint(ctx(root, [{ dir: 'api', ecosystem: 'go', build: 'true' }]));
    strictEqual(outcome.status, '⏭');
    match(outcome.lastLine, /НЕ проверялась|не найден/);
  });

  it('чистый прогон даёт ✅', async () => {
    ok(lint !== undefined);
    const root = repo();
    const outcome = await lint(ctx(root, [{ dir: 'api', build: 'true', lint: 'true' }]));
    strictEqual(outcome.status, '✅');
  });

  it('нарушения дают ❌, а не пропуск', async () => {
    ok(lint !== undefined);
    const root = repo();
    const outcome = await lint(ctx(root, [{ dir: 'api', build: 'true', lint: 'false' }]));
    strictEqual(outcome.status, '❌');
  });

  it('модуль без общепринятого линтера — ⏭ с названной причиной', async () => {
    ok(lint !== undefined);
    const root = repo();
    // У JVM в реестре линтера нет: выдумывать его нельзя, но и молчать тоже.
    const outcome = await lint(ctx(root, [{ dir: 'api', ecosystem: 'maven', build: 'true' }]));
    strictEqual(outcome.status, '⏭');
    match(outcome.lastLine, /линтера нет|НЕ проверялась/);
  });
});
