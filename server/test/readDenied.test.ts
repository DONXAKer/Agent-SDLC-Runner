/**
 * Чтение отчёта ЧУЖОЙ попытки на этапе 6 закрыто политикой.
 *
 * Методология запрещает давать рецензенту повторной попытки находки предыдущей: связь
 * между попытками несут `retry_instruction` и `carry_forward`, которые подаёт машина
 * витка. Живой прогон r23 показал цену доступности — слабая модель списала из соседнего
 * отчёта «Scope ❌ — snapshot.json вне плана», объективно зелёный гейт стал красным, и
 * виток, у которого сошлось всё, остался красным по выдумке.
 */

import { ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { NormalizedCall, PolicyContext } from '@sdlc-runner/shared';

import { evaluate } from '../src/policy/index.ts';

const ROOT = '/proj';

function ctx(over: Partial<PolicyContext> = {}): PolicyContext {
  return {
    projectRoot: ROOT,
    stage: 'verify',
    sdlcDir: '.sdlc/demo',
    planFiles: ['src/a.ts'],
    protectedArtifacts: [],
    readOnlyRoots: [],
    allowedTools: ['Read', 'Glob', 'Grep', 'Write', 'Edit'],
    mcpTools: [],
    readDenied: ['.sdlc/demo/verification-report-1-attempt-1.md'],
    ...over,
  };
}

const read = (path: string): NormalizedCall => ({ kind: 'read', path, range: null });

describe('чтение, закрытое на этапе', () => {
  it('отчёт прошлой попытки не читается', () => {
    const v = evaluate(read('.sdlc/demo/verification-report-1-attempt-1.md'), ctx());
    strictEqual(v.ok, false);
    ok(v.ok === false && v.policy === 'pathScope', JSON.stringify(v));
    ok(v.ok === false && /другой попытки/.test(v.reason), JSON.stringify(v));
  });

  it('абсолютный путь к тому же файлу тоже закрыт', () => {
    const v = evaluate(read(`${ROOT}/.sdlc/demo/verification-report-1-attempt-1.md`), ctx());
    strictEqual(v.ok, false);
  });

  it('отчёт ТЕКУЩЕЙ попытки читается: его этап и пишет', () => {
    strictEqual(evaluate(read('.sdlc/demo/verification-report-1-attempt-2.md'), ctx()).ok, true);
  });

  it('запись в закрытый на чтение путь этим правилом не трогается', () => {
    // Правило про чтение и только про чтение: запись в артефакты витка решает planScope,
    // и дублировать его тут значило бы завести второе место решения об одном и том же.
    const v = evaluate(
      { kind: 'write', path: '.sdlc/demo/verification-report-1-attempt-1.md', content: 'x' },
      ctx(),
    );
    strictEqual(v.ok, true);
  });

  it('каталог поиска, ведущий в закрытый файл, тоже закрыт', () => {
    const v = evaluate(
      { kind: 'grep', pattern: 'Scope', path: '.sdlc/demo/verification-report-1-attempt-1.md' },
      ctx(),
    );
    strictEqual(v.ok, false);
  });

  it('пустой список — прежнее поведение, ничего не закрыто', () => {
    strictEqual(
      evaluate(read('.sdlc/demo/verification-report-1-attempt-1.md'), ctx({ readDenied: [] })).ok,
      true,
    );
  });

  it('поле не задано вовсе — тоже прежнее поведение', () => {
    const bare = ctx();
    delete (bare as { readDenied?: readonly string[] }).readDenied;
    strictEqual(evaluate(read('.sdlc/demo/verification-report-1-attempt-1.md'), bare).ok, true);
  });
});
