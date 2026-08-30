/**
 * Гейт «Ответы человека в коде»: литералы из ответов (clarification-report.md) ищутся в
 * добавленных строках diff.
 *
 * Репозиторий настоящий: гейт читает рабочий diff через git, и подделка его вывода
 * проверяла бы константу, а не поведение.
 */

import { ok, strictEqual } from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { BUILTIN } from '../src/gates/builtin/index.ts';

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const gate = BUILTIN.get('ответы человека в коде');

const REPORT = `## Вопросы и ответы
| # | Вопрос | Блокирующий | Ответ человека | Что изменилось |
|---|---|---|---|---|
| 1 | Ставка для суммы >300см? | да | 90% от базовой цены | claim-3 |
| 2 | Как в зоне far? | да | на общих основаниях | claim-7 |
`;

/** Репозиторий с закоммиченным исходником и clarification-report вне индекса. */
function repo(): { root: string; clarificationPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'sdlc-answers-'));
  roots.push(root);
  const run = (args: string[]): void => {
    execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  };
  run(['init', '-q']);
  run(['config', 'user.email', 'test@example.invalid']);
  run(['config', 'user.name', 'test']);
  writeFileSync(join(root, 'tariffs.ts'), 'export const base = 100;\n');
  run(['add', '.']);
  run(['commit', '-qm', 'база']);
  const clarificationPath = join(root, 'clarification-report.md');
  writeFileSync(clarificationPath, REPORT);
  return { root, clarificationPath };
}

async function outcomeOf(root: string, clarificationPath?: string): Promise<{ status: string; lastLine: string }> {
  ok(gate !== undefined, 'гейт не зарегистрирован в BUILTIN');
  const r = await gate({
    projectRoot: root,
    planFiles: [],
    baseline: null,
    timeoutMs: 120_000,
    ...(clarificationPath === undefined ? {} : { clarificationPath }),
  });
  return { status: r.status, lastLine: r.lastLine };
}

describe('гейт «Ответы человека в коде»', () => {
  it('claim-1: литерал ответа в добавленных строках — зелёный', async () => {
    const { root, clarificationPath } = repo();
    writeFileSync(join(root, 'tariffs.ts'), 'export const base = 100;\nexport const RATE = 0.9;\n');
    const { status } = await outcomeOf(root, clarificationPath);
    strictEqual(status, '✅');
  });

  it('claim-2: потерянный литерал роняет гейт и называет вопрос с ответом', async () => {
    const { root, clarificationPath } = repo();
    writeFileSync(join(root, 'tariffs.ts'), 'export const base = 100;\nexport const RATE = 0.4;\n');
    const { status, lastLine } = await outcomeOf(root, clarificationPath);
    strictEqual(status, '❌');
    ok(lastLine.includes('Ставка для суммы >300см?'), lastLine);
    ok(lastLine.includes('90%'), lastLine);
  });

  it('claim-3: «90» не зеленеет от «190» — число ищется как отдельный токен', async () => {
    const { root, clarificationPath } = repo();
    writeFileSync(join(root, 'tariffs.ts'), 'export const base = 100;\nexport const x = 190;\n');
    const { status } = await outcomeOf(root, clarificationPath);
    strictEqual(status, '❌');
  });

  it('claim-4: отчёта нет — сверять нечего, зелёный с честной формулировкой', async () => {
    const { root } = repo();
    writeFileSync(join(root, 'tariffs.ts'), 'export const base = 100;\nexport const y = 1;\n');
    const { status, lastLine } = await outcomeOf(root);
    strictEqual(status, '✅');
    ok(lastLine.includes('сверять нечего'), lastLine);
  });

  it('claim-5 [edge]: ответы без литералов («на общих основаниях») не проверяются и не роняют', async () => {
    const { root, clarificationPath } = repo();
    writeFileSync(
      clarificationPath,
      '## Вопросы и ответы\n| # | В | Б | О | И |\n|---|---|---|---|---|\n| 1 | Как в far? | да | на общих основаниях | claim-7 |\n',
    );
    writeFileSync(join(root, 'tariffs.ts'), 'export const base = 100;\nexport const y = 1;\n');
    const { status, lastLine } = await outcomeOf(root, clarificationPath);
    strictEqual(status, '✅');
    ok(lastLine.includes('нет проверяемых литералов'), lastLine);
  });

  it('claim-6 [edge]: не git-репозиторий — пропуск, а не провал', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-answers-plain-'));
    roots.push(root);
    const { status } = await outcomeOf(root);
    strictEqual(status, '⏭');
  });
});
