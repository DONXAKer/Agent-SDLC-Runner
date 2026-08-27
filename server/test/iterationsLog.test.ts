/**
 * Журнал итераций витка.
 *
 * Проверяется то, ради чего он заводился: строка ДОПИСЫВАЕТСЯ (стёртая улика не
 * восстанавливается), в ней только машинно наблюдаемое, а пустая колонка заметки не
 * притворяется отсутствием замечаний.
 */

import { ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { GateRunResult, Verdict } from '@sdlc-runner/shared';

import { appendIteration, iterationRow } from '../src/run/iterationsLog.ts';

const patch = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,2 +1,3 @@',
  ' ctx',
  '+добавлено',
  '-удалено',
].join('\n');

const red: Verdict = { passed: false, action: 'retry', reasons: ['пункт приёмки c1 опровергнут'] };
const green: Verdict = { passed: true, action: 'continue', reasons: [] };

const gate = (over: Partial<GateRunResult> = {}): GateRunResult => ({
  name: 'Тесты',
  status: '❌',
  command: 'npm test',
  exitCode: 1,
  lastLine: '2 failing',
  durationMs: 10,
  ...over,
});

const rec = (over: Record<string, unknown> = {}) => ({
  chunk: 1,
  attempt: 2,
  verdict: red,
  gates: [gate()],
  patch,
  closeness: 0.75,
  noProgress: false,
  at: new Date('2026-08-19T12:34:56Z'),
  ...over,
});

describe('строка журнала итераций', () => {
  it('содержит chunk, попытку и исход', () => {
    const row = iterationRow(rec());
    ok(row.includes('| 1 |'));
    ok(row.includes('| 2 |'));
    ok(row.includes('retry'));
  });

  it('размер патча считается машинно: файлы и изменённые строки', () => {
    const row = iterationRow(rec());
    // Один файл, две изменённые строки (одна добавлена, одна удалена).
    ok(/\| 1 \| 2 \|/.test(row), `нет размера патча в строке: ${row}`);
  });

  it('причины переносятся дословно, вместе с упавшими гейтами', () => {
    const row = iterationRow(rec());
    ok(row.includes('пункт приёмки c1 опровергнут'));
    ok(row.includes('❌ Тесты'));
  });

  it('зелёные гейты в причины не попадают', () => {
    const row = iterationRow(rec({ verdict: green, gates: [gate({ status: '✅' })] }));
    strictEqual(row.includes('Тесты'), false);
    ok(row.includes('passed'));
  });

  it('отсутствие прогресса называется прямо, а не процентом', () => {
    ok(iterationRow(rec({ noProgress: true })).includes('патч тот же'));
  });

  it('несчитанная близость — прочерк, а не ноль', () => {
    ok(iterationRow(rec({ closeness: null })).includes('| — |'));
  });

  it('перевод строки и труба в причинах не ломают таблицу', () => {
    const row = iterationRow(
      rec({ verdict: { passed: false, action: 'retry', reasons: ['a\nb | c'] } }),
    );
    strictEqual(row.split('\n').length, 1);
    ok(row.includes('\\|'));
  });
});

describe('дописывание журнала', () => {
  it('первый вызов создаёт шапку с колонками', () => {
    const text = appendIteration('', rec());
    ok(text.includes('# Журнал итераций витка'));
    ok(text.includes('| Когда | Chunk |'));
  });

  it('второй вызов дописывает строку, не трогая первую', () => {
    const first = appendIteration('', rec({ attempt: 1 }));
    const second = appendIteration(first, rec({ attempt: 2 }));
    const rows = second.split('\n').filter((l) => l.startsWith('| ') && !l.includes('---'));
    // Шапка таблицы плюс две строки попыток.
    strictEqual(rows.length, 3);
    ok(second.includes(first.trim().split('\n').slice(-1)[0] ?? ''));
  });

  it('шапка не дублируется при дописывании', () => {
    const twice = appendIteration(appendIteration('', rec()), rec());
    strictEqual(twice.split('# Журнал итераций витка').length - 1, 1);
  });
});
