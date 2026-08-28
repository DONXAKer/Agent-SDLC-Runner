/**
 * Гейт «Scope: нетракованные файлы».
 *
 * Строка набора, которую проекты закрывали командой `git status --porcelain`: она печатает
 * список, но возвращает 0 при любом его содержимом — гейт зеленел всегда. Тест проверяет то,
 * ради чего встроенная реализация и заведена: что непустой список действительно роняет гейт.
 *
 * Репозиторий настоящий, а не мок: подделать вывод `git ls-files` значило бы проверить
 * собственную константу, а не поведение git'а — включая то, как он обходится с `.gitignore`.
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

const gate = BUILTIN.get('scope: нетракованные файлы');

/** Пустой каталог без git — вход для случая «не репозиторий». */
function plainDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'sdlc-untracked-'));
  roots.push(root);
  return root;
}

/** Репозиторий с одним коммитом: без него `ls-files` работает, но состояние нетипично. */
function repo(): string {
  const root = plainDir();
  const run = (args: string[]): void => {
    execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  };
  run(['init', '-q']);
  run(['config', 'user.email', 'test@example.invalid']);
  run(['config', 'user.name', 'test']);
  writeFileSync(join(root, 'README.md'), 'проба\n');
  run(['add', 'README.md']);
  run(['commit', '-qm', 'первый']);
  return root;
}

async function runGate(root: string): Promise<{ status: string; lastLine: string }> {
  ok(gate !== undefined, 'гейт не зарегистрирован в BUILTIN');
  const outcome = await gate({ projectRoot: root, planFiles: [], baseline: null, timeoutMs: 120_000 });
  return { status: outcome.status, lastLine: outcome.lastLine };
}

describe('гейт «Scope: нетракованные файлы»', () => {
  it('claim-1: не git-репозиторий — пропуск, а не провал', async () => {
    const { status, lastLine } = await runGate(plainDir());
    strictEqual(status, '⏭');
    ok(lastLine.includes('не git-репозиторий'), lastLine);
  });

  it('claim-2: нетракованный файл вне .sdlc/ роняет гейт и называется по имени', async () => {
    const root = repo();
    writeFileSync(join(root, 'забытый.ts'), 'export const a = 1;\n');
    const { status, lastLine } = await runGate(root);
    strictEqual(status, '❌');
    ok(lastLine.includes('забытый.ts'), lastLine);
  });

  it('claim-3: нетрак внутри .sdlc/ нарушением не считается', async () => {
    const root = repo();
    mkdirSync(join(root, '.sdlc', 'проба'), { recursive: true });
    writeFileSync(join(root, '.sdlc', 'проба', 'plan.md'), '# план\n');
    const { status } = await runGate(root);
    strictEqual(status, '✅');
  });

  it('claim-4 [edge]: игнорируемый git-ом файл нарушением не считается', async () => {
    const root = repo();
    writeFileSync(join(root, '.gitignore'), 'build/\n');
    execFileSync('git', ['add', '.gitignore'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['commit', '-qm', 'игнор'], { cwd: root, stdio: 'ignore' });
    mkdirSync(join(root, 'build'));
    writeFileSync(join(root, 'build', 'out.js'), 'console.log(1)\n');
    const { status } = await runGate(root);
    strictEqual(status, '✅');
  });

  it('claim-4 [edge]: заведённый в индекс файл нарушением не считается', async () => {
    const root = repo();
    writeFileSync(join(root, 'новый.ts'), 'export const b = 2;\n');
    execFileSync('git', ['add', 'новый.ts'], { cwd: root, stdio: 'ignore' });
    const { status } = await runGate(root);
    strictEqual(status, '✅');
  });

  it('claim-5: гейт зарегистрирован под именем строки набора', () => {
    ok(BUILTIN.has('scope: нетракованные файлы'));
  });
});
