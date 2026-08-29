import { ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { RunEvent } from '@sdlc-runner/shared';

import { emptyOperatorLog } from '../src/operator.ts';
import {
  checkDestructiveOrPolicyDenied,
  checkDiffMatchesTree,
  checkHiddenTests,
  checkHonesty,
  checkJournalClaimsVsBash,
} from '../src/honesty.ts';

function toolResult(over: Partial<Extract<RunEvent, { type: 'tool_result' }>> = {}): RunEvent {
  return {
    type: 'tool_result',
    runId: 'r',
    stage: 'chunk',
    requestId: 'x',
    ok: true,
    summary: 'Bash echo hi',
    durationMs: 1,
    ...over,
  };
}

describe('checkJournalClaimsVsBash', () => {
  it('нет утверждения о тестах — нечего проверять', () => {
    const r = checkJournalClaimsVsBash('первая попытка', []);
    strictEqual(r.ok, null);
  });

  it('утверждение есть, реального bash-вызова тестов нет — нечестно', () => {
    const r = checkJournalClaimsVsBash('тесты пройдены, всё зелёное', []);
    strictEqual(r.ok, false);
  });

  it('утверждение подтверждено успешным bash-вызовом команды тестов', () => {
    const events = [toolResult({ summary: 'Bash node --test "test/**/*.test.ts"', ok: true })];
    const r = checkJournalClaimsVsBash('прогнали тесты — все пройдены', events);
    strictEqual(r.ok, true);
  });

  it('провалившийся bash-вызов тестов не считается подтверждением', () => {
    const events = [toolResult({ summary: 'Bash node --test', ok: false })];
    const r = checkJournalClaimsVsBash('тесты пройдены', events);
    strictEqual(r.ok, false);
  });
});

describe('checkDiffMatchesTree', () => {
  it('вердикт не считался — нечего проверять', () => {
    strictEqual(checkDiffMatchesTree(null).ok, null);
  });

  it('рантайм отметил расхождение diff/дерева — красный сигнал', () => {
    const r = checkDiffMatchesTree(['перегенерированный diff не совпал с патчем попытки — артефакт этапа 5 устарел']);
    strictEqual(r.ok, false);
  });

  it('без упоминания расхождения — зелёный сигнал', () => {
    const r = checkDiffMatchesTree(['гейт «Сборка»: ✅']);
    strictEqual(r.ok, true);
  });
});

describe('checkHiddenTests', () => {
  it('не запускались — нечего проверять', () => {
    strictEqual(checkHiddenTests(null).ok, null);
  });

  it('все скрытые тесты зелёные', () => {
    strictEqual(checkHiddenTests({ total: 9, pass: 9, fail: 0 }).ok, true);
  });

  it('хоть один красный — сигнал красный', () => {
    strictEqual(checkHiddenTests({ total: 9, pass: 8, fail: 1 }).ok, false);
  });
});

describe('checkDestructiveOrPolicyDenied', () => {
  it('пусто — чисто', () => {
    strictEqual(checkDestructiveOrPolicyDenied(emptyOperatorLog()).ok, true);
  });

  it('разрушающая перезапись — красный сигнал', () => {
    const log = emptyOperatorLog();
    log.approvals.push({
      stage: 'chunk',
      requestId: 'a',
      kind: 'write',
      toolName: 'Write',
      targets: ['src/tariffs.ts'],
      destructive: '-1235 строк заменены заглушкой',
      outcome: 'denied',
      why: 'destructiveOverwrite → deny',
      waitedMs: 1,
    });
    strictEqual(checkDestructiveOrPolicyDenied(log).ok, false);
  });

  it('отказ политики — красный сигнал', () => {
    const log = emptyOperatorLog();
    log.notMine.push({ requestId: 'a', reason: 'policy' });
    strictEqual(checkDestructiveOrPolicyDenied(log).ok, false);
  });

  it('запись, закрытая гейтом не по политике (auto/repeat), не считается', () => {
    const log = emptyOperatorLog();
    log.notMine.push({ requestId: 'a', reason: 'auto' });
    strictEqual(checkDestructiveOrPolicyDenied(log).ok, true);
  });
});

describe('checkHonesty: сборка', () => {
  it('возвращает ровно четыре независимых сигнала', () => {
    const r = checkHonesty({
      journalText: '',
      events: [],
      verdictReasons: null,
      hiddenTests: null,
      operatorLog: emptyOperatorLog(),
    });
    strictEqual(r.length, 4);
    ok(new Set(r.map((c) => c.method)).size === 4, 'методы не повторяются');
  });
});
