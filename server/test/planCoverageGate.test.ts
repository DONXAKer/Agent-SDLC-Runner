/**
 * Гейт «Scope: пути плана без правок» — путь-КАТАЛОГ закрывается файлом внутри него.
 *
 * Живой прогон (gpt-oss-20b, rename-field, 2026-09-24): `files_to_touch` несли `test` —
 * каталог из «Что придётся тронуть» задачи, — модель создала `test/store.compat.test.ts`,
 * а гейт три попытки подряд краснел «путей плана без правок: 1 из 5 test». Рецензент
 * каждый раз писал «по существу закрыт», и провал был исключительно разбором.
 *
 * Репозиторий настоящий, как в `untrackedGate.test.ts`: `changedPaths` спрашивает git, и
 * подделка его вывода проверяла бы собственную константу.
 */

import { ok, strictEqual } from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { BUILTIN } from '../src/gates/builtin/index.ts';

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const gate = BUILTIN.get('scope: пути плана без правок');

/** Репозиторий с одним коммитом: `src/a.ts` и `docs/readme.md` в индексе. */
function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'sdlc-plancov-'));
  roots.push(root);
  const run = (args: string[]): void => {
    execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  };
  run(['init', '-q']);
  run(['config', 'user.email', 'test@example.invalid']);
  run(['config', 'user.name', 'test']);
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'docs'));
  mkdirSync(join(root, 'test'));
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(root, 'docs', 'readme.md'), 'доки\n');
  run(['add', '.']);
  run(['commit', '-qm', 'первый']);
  return root;
}

async function runGate(root: string, planFiles: string[]): Promise<{ status: string; lastLine: string }> {
  ok(gate !== undefined, 'гейт не зарегистрирован в BUILTIN');
  const outcome = await gate({ projectRoot: root, planFiles, baseline: null, timeoutMs: 120_000 });
  return { status: outcome.status, lastLine: outcome.lastLine };
}

describe('гейт «Scope: пути плана без правок»: путь-каталог', () => {
  it('каталог плана закрыт СОЗДАННЫМ внутри файлом — зелёный', async () => {
    const root = repo();
    writeFileSync(join(root, 'test', 'store.compat.test.ts'), 'import test from "node:test";\n');
    const { status } = await runGate(root, ['test']);
    strictEqual(status, '✅');
  });

  it('каталог с хвостовым слэшем — то же самое', async () => {
    const root = repo();
    writeFileSync(join(root, 'test', 'new.test.ts'), 'x\n');
    const { status } = await runGate(root, ['test/']);
    strictEqual(status, '✅');
  });

  it('файл плана рядом с каталогом: покрыты оба — зелёный', async () => {
    const root = repo();
    writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 2;\n');
    writeFileSync(join(root, 'test', 'new.test.ts'), 'x\n');
    const { status } = await runGate(root, ['src/a.ts', 'test']);
    strictEqual(status, '✅');
  });

  it('каталог без единой правки внутри — по-прежнему ❌ и назван по имени', async () => {
    const root = repo();
    writeFileSync(join(root, 'test', 'new.test.ts'), 'x\n');
    const { status, lastLine } = await runGate(root, ['test', 'docs']);
    strictEqual(status, '❌');
    ok(lastLine.includes('docs'), lastLine);
    ok(!lastLine.includes('test'), `покрытый каталог в списке непокрытых: ${lastLine}`);
  });

  it('имя файла как префикс чужого пути каталогом не становится', async () => {
    // `src/a.ts` в плане, а тронут `src/a.tsx` — префиксом «src/a.ts» не закрывается:
    // сравнение идёт по `src/a.ts/`, и такого пути не бывает.
    const root = repo();
    writeFileSync(join(root, 'src', 'a.tsx'), 'x\n');
    const { status, lastLine } = await runGate(root, ['src/a.ts']);
    strictEqual(status, '❌');
    ok(lastLine.includes('src/a.ts'), lastLine);
  });
});
