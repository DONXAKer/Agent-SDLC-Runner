/**
 * Проверка шага 3 ROADMAP.md — чистое ядро драйвера, без модели и без сети.
 *
 * `runBench` целиком (цикл по `STAGE_ORDER`) не тестируется здесь: первый этап (`intent`)
 * по конструкции `requires: []` — методология требует, чтобы виток доходил до него без
 * единого блокера, — и драйвер, дойдя до него, зовёт настоящую модель. Проверка полного
 * цикла — ручная, `--stage intent --model claude-sdk:haiku` (см. ROADMAP.md, шаг 3), не
 * герметичный тест. Здесь проверяется вынесенное из цикла чистое ядро: `decideAfterVerify`
 * (что означает вердикт этапа 6) и `attemptCeiling` (потолок попыток).
 */

import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { emptyUsage } from '@sdlc-runner/shared';
import type { Verdict } from '@sdlc-runner/shared';

import type { Run } from '../../server/src/run/Run.ts';
import type { StageResult } from '../../server/src/exec/StageExecutor.ts';
import { attemptCeiling, decideAfterStageFailure, decideAfterVerify, runBench } from '../src/driver.ts';

function verdict(action: Verdict['action'], passed = false): Verdict {
  return { passed, action, reasons: [] };
}

describe('attemptCeiling', () => {
  it('берёт меньшее из бюджета раннера и --attempts бенчмарка', () => {
    strictEqual(attemptCeiling({ attemptBudget: 5 }, 3), 3);
    strictEqual(attemptCeiling({ attemptBudget: 2 }, 3), 2);
    strictEqual(attemptCeiling({ attemptBudget: 4 }, 4), 4);
  });
});

describe('decideAfterStageFailure', () => {
  it('обычный провал (без envFailure) — сразу blocked, повтора нет', () => {
    deepStrictEqual(
      decideAfterStageFailure({ stage: 'intent', envFailure: undefined, alreadyRetriedThisStage: false }),
      { kind: 'stop', reason: 'blocked' },
    );
  });

  it('envFailure первый раз на этапе — один повтор самого этапа', () => {
    deepStrictEqual(
      decideAfterStageFailure({ stage: 'explore', envFailure: 'HTTP 500', alreadyRetriedThisStage: false }),
      { kind: 'retry-stage-env' },
    );
  });

  it('envFailure второй раз подряд на том же этапе — отдельная остановка, не blocked', () => {
    deepStrictEqual(
      decideAfterStageFailure({ stage: 'explore', envFailure: 'HTTP 500', alreadyRetriedThisStage: true }),
      { kind: 'stop', reason: 'stage-env-repeat' },
    );
  });

  it('verify исключена — у неё свой механизм (decideAfterVerify), envFailure здесь не даёт повтора', () => {
    deepStrictEqual(
      decideAfterStageFailure({ stage: 'verify', envFailure: 'HTTP 500', alreadyRetriedThisStage: false }),
      { kind: 'stop', reason: 'blocked' },
    );
  });
});

/**
 * `runBench` не тестируется здесь целиком по причине из шапки файла (`intent` без единого
 * блокера зовёт настоящую модель) — но это относится к РЕАЛЬНОМУ `Run`, не к этому тесту:
 * `run` здесь полностью подставной (`blockers`/`runStage`/`cancel` — стабы, без сети и
 * модели), и проверяется только бухгалтерия `stages[]` вокруг `retry-stage-env`
 * (code-review-all, 2026-09-14).
 */
describe('runBench: бухгалтерия stages[] при retry-stage-env', () => {
  it('повтор этапа после envFailure оставляет в stages[] ОДНУ запись — успешную, не обе', async () => {
    let calls = 0;
    const fakeRun = {
      chunk: 1,
      attempt: 1,
      lastVerdict: null,
      blockers: () => [],
      blockerDetails: () => [],
      cancel: () => {},
      runStage: async (): Promise<StageResult> => {
        calls++;
        if (calls === 1) {
          return { ok: false, finalText: '', usage: emptyUsage(), note: 'апстрим не ответил', envFailure: 'HTTP 500' };
        }
        return { ok: true, finalText: 'готово', usage: emptyUsage(), note: 'готово' };
      },
    } as unknown as Run;

    const result = await runBench({
      run: fakeRun,
      stageTimeoutMs: 10_000,
      runTimeoutMs: 60_000,
      attempts: 3,
      stopAfterStage: 'intent',
    });

    strictEqual(calls, 2, 'ожидались ровно попытка + один повтор');
    strictEqual(result.stopped, 'snapshot-point');
    const intentRecords = result.stages.filter((s) => s.stage === 'intent');
    strictEqual(intentRecords.length, 1, JSON.stringify(result.stages));
    strictEqual(intentRecords[0]?.ok, true, JSON.stringify(intentRecords));
  });
});

/**
 * `explore` — единственный этап, у которого одновременно есть `skipIf` (мелкий контур) и
 * `humanGate`: пропуск не создаёт артефакт (`finalText:'', usage.durationMs:0`), и
 * `recordDecision`, вызванный по-прежнему, бросал бы `DecisionFormError` не по вине модели.
 * Живой пример — серия test21, 2026-09-17: 3 из 5 прогонов `qwen3-8b-stepfill-compactfill`
 * шли в `blocked` ровно так.
 */
describe('runBench: пропуск этапа (skipIf) не зовёт recordDecision', () => {
  it('мелкий контур — этап пропущен, recordDecision не вызывается, remains ok', async () => {
    const fakeRun = {
      chunk: 1,
      attempt: 1,
      lastVerdict: null,
      blockers: () => [],
      blockerDetails: () => [],
      cancel: () => {},
      recordDecision: () => {
        throw new Error('recordDecision не должен был вызываться при пропуске этапа');
      },
      runStage: async (): Promise<StageResult> => ({
        ok: true,
        finalText: '',
        usage: emptyUsage(),
        note: 'мелкий контур: разведка точечная на этапе 5, отчёт не пишется',
      }),
    } as unknown as Run;

    const result = await runBench({
      run: fakeRun,
      stageTimeoutMs: 10_000,
      runTimeoutMs: 60_000,
      attempts: 3,
      startStage: 'explore',
      stopAfterStage: 'explore',
    });

    strictEqual(result.stopped, 'snapshot-point', JSON.stringify(result));
    const [explore] = result.stages;
    strictEqual(explore?.ok, true);
    strictEqual(explore?.skipped, true);
  });

  it('обычный (не пропущенный) успешный explore по-прежнему зовёт recordDecision', async () => {
    let recordDecisionCalls = 0;
    const fakeRun = {
      chunk: 1,
      attempt: 1,
      lastVerdict: null,
      blockers: () => [],
      blockerDetails: () => [],
      cancel: () => {},
      recordDecision: () => {
        recordDecisionCalls++;
        return 'Гриц · 2026-09-17';
      },
      runStage: async (): Promise<StageResult> => ({
        ok: true,
        finalText: '# Разведка\n\nготово',
        usage: { ...emptyUsage(), durationMs: 1200 },
        note: 'готово',
      }),
    } as unknown as Run;

    const result = await runBench({
      run: fakeRun,
      stageTimeoutMs: 10_000,
      runTimeoutMs: 60_000,
      attempts: 3,
      startStage: 'explore',
      stopAfterStage: 'explore',
    });

    strictEqual(result.stopped, 'snapshot-point', JSON.stringify(result));
    strictEqual(result.stages[0]?.skipped, false);
    strictEqual(recordDecisionCalls, 1, 'обычный ход обязан записать решение человека');
  });
});

describe('runBench: запись блокировки и признаки этапа', () => {
  it('блокировка входа несёт этап-виновника; прошедший этап — ходы и «закрыт рантаймом»', async () => {
    const blocker = 'в intent.md осталось незаполненных мест: 1 — артефакт не готов';
    const fakeRun = {
      chunk: 1,
      attempt: 1,
      lastVerdict: null,
      blockers: () => [],
      blockerDetails: (stage: string) => (stage === 'explore' ? [{ text: blocker, blamed: 'intent' }] : []),
      cancel: () => {},
      runStage: async (): Promise<StageResult> => ({
        ok: true,
        finalText: 'готово',
        usage: emptyUsage(),
        note: 'готово',
        turns: 4,
        closedBy: 'runtime',
      }),
    } as unknown as Run;

    const result = await runBench({ run: fakeRun, stageTimeoutMs: 10_000, runTimeoutMs: 60_000, attempts: 3 });

    strictEqual(result.stopped, 'blocked');
    const [intent, explore] = result.stages;
    strictEqual(intent?.turns, 4);
    strictEqual(intent?.closedBy, 'runtime');
    strictEqual(explore?.blamedStage, 'intent');
    deepStrictEqual(explore?.blockers, [blocker]);
  });
});

describe('runBench: обращения к модели у исполнителей без цикла ходов', () => {
  it('modelRequests из StageResult переносится в запись этапа, turns при этом не выдумывается', async () => {
    const fakeRun = {
      chunk: 1,
      attempt: 1,
      lastVerdict: null,
      blockers: () => [],
      blockerDetails: () => [],
      cancel: () => {},
      runStage: async (): Promise<StageResult> =>
        ({ ok: true, finalText: 'готово', usage: emptyUsage(), note: 'готово', modelRequests: 12, closedBy: 'runtime' }) as StageResult,
    } as unknown as Run;

    const result = await runBench({ run: fakeRun, stageTimeoutMs: 10_000, runTimeoutMs: 60_000, attempts: 3, stopAfterStage: 'intent' });

    strictEqual(result.stages[0]?.modelRequests, 12);
    strictEqual(result.stages[0]?.turns, undefined);
  });
});

describe('decideAfterVerify', () => {
  it('continue — виток идёт дальше к handoff', () => {
    const d = decideAfterVerify({ verdict: verdict('continue', true), attempt: 1, attemptCeiling: 3, blockedEnvStreak: 0 });
    deepStrictEqual(d, { kind: 'continue' });
  });

  it('retry в пределах потолка — новая попытка', () => {
    const d = decideAfterVerify({ verdict: verdict('retry'), attempt: 1, attemptCeiling: 3, blockedEnvStreak: 0 });
    deepStrictEqual(d, { kind: 'retry' });
  });

  it('retry на потолке попыток — остановка attempts-exhausted', () => {
    const d = decideAfterVerify({ verdict: verdict('retry'), attempt: 3, attemptCeiling: 3, blockedEnvStreak: 0 });
    deepStrictEqual(d, { kind: 'stop', reason: 'attempts-exhausted' });
  });

  it('retry выше потолка (не должно случаться, но не должно и провисать) — тоже остановка', () => {
    const d = decideAfterVerify({ verdict: verdict('retry'), attempt: 4, attemptCeiling: 3, blockedEnvStreak: 0 });
    deepStrictEqual(d, { kind: 'stop', reason: 'attempts-exhausted' });
  });

  it('escalate — законный исход про модель, остановка', () => {
    const d = decideAfterVerify({ verdict: verdict('escalate'), attempt: 1, attemptCeiling: 3, blockedEnvStreak: 0 });
    deepStrictEqual(d, { kind: 'stop', reason: 'escalate' });
  });

  it('blocked_env первый раз — повтор verify, попытка не тратится', () => {
    const d = decideAfterVerify({ verdict: verdict('blocked_env'), attempt: 1, attemptCeiling: 3, blockedEnvStreak: 0 });
    deepStrictEqual(d, { kind: 'retry-verify-env' });
  });

  it('blocked_env второй раз подряд — остановка, машину чинить вне витка', () => {
    const d = decideAfterVerify({ verdict: verdict('blocked_env'), attempt: 1, attemptCeiling: 3, blockedEnvStreak: 1 });
    deepStrictEqual(d, { kind: 'stop', reason: 'blocked-env-repeat' });
  });
});
