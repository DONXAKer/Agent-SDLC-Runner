/**
 * Гейт «Перезапись файла» (`SDLC.md`): файл, потерявший ≥ 50 % строк базы или удалённый
 * целиком, обязан иметь строку подтверждения с именем человека в журнале chunk'а — иначе ❌.
 * На настоящем git-репозитории: длина файла на базе читается `git show`.
 */

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import type { GateContext } from '../src/gates/builtin/index.ts';
import { builtinFor } from '../src/gates/builtin/index.ts';
import { overwriteConfirmations, overwriteGate } from '../src/gates/builtin/overwrite.ts';
import { git } from '../src/gates/git.ts';

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function lines(n: number): string {
  return Array.from({ length: n }, (_, i) => `строка ${i}`).join('\n') + '\n';
}

async function repo(): Promise<{ root: string; base: string }> {
  const root = mkdtempSync(join(tmpdir(), 'sdlc-overwrite-'));
  roots.push(root);
  await git(['init', '-q'], root);
  await git(['config', 'user.email', 'sdlc@test'], root);
  await git(['config', 'user.name', 'sdlc'], root);
  await git(['config', 'core.autocrlf', 'false'], root);
  writeFileSync(join(root, 'big.ts'), lines(100), 'utf8');
  writeFileSync(join(root, 'small.ts'), lines(10), 'utf8');
  writeFileSync(join(root, 'gone.ts'), lines(3), 'utf8');
  await git(['add', '-A'], root);
  await git(['commit', '-q', '-m', 'base'], root);
  const base = (await git(['rev-parse', 'HEAD'], root)).stdout.trim();
  return { root, base };
}

function ctx(root: string, base: string, journal?: string): GateContext {
  const j = join(root, '.sdlc', 'demo', 'chunk-1-journal.md');
  if (journal !== undefined) {
    mkdirSync(join(root, '.sdlc', 'demo'), { recursive: true });
    writeFileSync(j, journal, 'utf8');
  }
  return { projectRoot: root, planFiles: [], baseline: null, timeoutMs: 5000, baseSha: base, journalPath: j };
}

describe('гейт «Перезапись файла»', () => {
  it('зарегистрирован под именем перечня', () => {
    ok(builtinFor('Перезапись файла') !== null);
  });

  it('обычная правка — ✅; заглушка вместо файла и удаление без подтверждения — ❌ с уликами', async () => {
    const { root, base } = await repo();
    writeFileSync(join(root, 'small.ts'), lines(10).replace('строка 3', 'строка три'), 'utf8');
    const clean = await overwriteGate(ctx(root, base));
    strictEqual(clean.status, '✅');

    writeFileSync(join(root, 'big.ts'), lines(11), 'utf8');
    rmSync(join(root, 'gone.ts'));
    const red = await overwriteGate(ctx(root, base));
    strictEqual(red.status, '❌');
    ok(red.lastLine.includes('big.ts — потеряно 89 из 100 строк базы (89 %)'), red.lastLine);
    ok(red.lastLine.includes('gone.ts — удалён целиком'), red.lastLine);
    ok(red.lastLine.includes('Перезапись файлов'), 'сказано, где подтверждать');
    deepStrictEqual(red.evidence?.length, 2);
  });

  it('подтверждение с именем в журнале снимает красный; плейсхолдер вместо имени — нет', async () => {
    const { root, base } = await repo();
    writeFileSync(join(root, 'big.ts'), lines(11), 'utf8');
    const signed = [
      '# Журнал chunk 1',
      '',
      '## Перезапись файлов',
      '',
      '- big.ts — перегенерация из схемы, старое содержимое устарело — подтвердил Иван Петров · 2026-09-23',
      '',
      '## Попытки',
      '',
    ].join('\n');
    strictEqual((await overwriteGate(ctx(root, base, signed))).status, '✅');

    const unsigned = signed.replace('подтвердил Иван Петров · 2026-09-23', 'подтвердил ‹имя› · ‹дата›');
    strictEqual((await overwriteGate(ctx(root, base, unsigned))).status, '❌');

    const none = signed.replace(/- big\.ts.*\n/, '- н/п — ни один файл не теряет половины строк и не удаляется целиком\n');
    strictEqual((await overwriteGate(ctx(root, base, none))).status, '❌');
  });

  it('overwriteConfirmations: путь, причина, имя; н/п и чужие секции не считаются', () => {
    const c = overwriteConfirmations(
      ['## Попытки', '- src/x.ts — не та секция — подтвердил Пётр · 2026-01-01', '## Перезапись файлов', '- н/п — ничего', '- `src/a.ts` — свёртка — подтвердил Анна · 2026-09-23', '## Дальше', '- src/b.ts — тоже не та — подтвердил Олег · 2026-01-01'].join('\n'),
    );
    deepStrictEqual(c, [{ path: 'src/a.ts', why: 'свёртка', signedBy: 'Анна' }]);
  });
});
