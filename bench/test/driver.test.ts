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

describe('runBench: stage-timeout не теряет прогресс, если следующий этап уже разблокирован', () => {
  it('артефакт закрыт до разрыва по часам (FormFillExecutor успел дописать поля) — виток продолжает, не stage-timeout', async () => {
    let cancelled = false;
    const fakeRun = {
      chunk: 1,
      attempt: 1,
      lastVerdict: null,
      blockers: () => [],
      // intent «разблокирован» с самого начала (требование методологии — requires: []);
      // explore разблокирован ТОЛЬКО после cancel() — как будто FormFillExecutor успел
      // дозаполнить артефакт до разрыва по часам.
      blockerDetails: (stage: string) => (stage === 'explore' && cancelled ? [] : stage === 'explore' ? [{ text: 'не готов', blamed: 'intent' }] : []),
      cancel: () => {
        cancelled = true;
      },
      recordDecision: () => {},
      runStage: async (stage: string): Promise<StageResult> => {
        if (stage !== 'intent') return { ok: true, finalText: 'готово', usage: emptyUsage(), note: 'готово', closedBy: 'runtime' } as StageResult;
        // Дольше stageTimeoutMs — гонка в runStageWithTimeout разрешится таймаутом,
        // cancel() позовётся, и ЭТОТ промис досидит и вернёт результат отменённого хода.
        await new Promise((r) => setTimeout(r, 40));
        return { ok: false, finalText: '', usage: emptyUsage(), note: 'этап отменён' };
      },
    } as unknown as Run;

    const result = await runBench({ run: fakeRun, stageTimeoutMs: 10, runTimeoutMs: 60_000, attempts: 3, stopAfterStage: 'explore' });

    strictEqual(cancelled, true, 'run.cancel() обязан был позваться при разрыве');
    strictEqual(result.stopped, 'snapshot-point', 'stopAfterStage останавливает штатно, не stage-timeout');
    const [intent, explore] = result.stages;
    strictEqual(intent?.timedOut, true);
    strictEqual(intent?.ok, false);
    strictEqual(explore?.stage, 'explore', 'виток дошёл до следующего этапа вместо немедленной остановки');
  });

  it('следующий этап всё ещё блокирован — остановка «stage-timeout», как и раньше', async () => {
    const fakeRun = {
      chunk: 1,
      attempt: 1,
      lastVerdict: null,
      blockers: () => [],
      blockerDetails: (stage: string) => (stage === 'explore' ? [{ text: 'в intent.md осталось незаполненных мест: 5', blamed: 'intent' }] : []),
      cancel: () => {},
      runStage: async (): Promise<StageResult> => {
        await new Promise((r) => setTimeout(r, 40));
        return { ok: false, finalText: '', usage: emptyUsage(), note: 'этап отменён' };
      },
    } as unknown as Run;

    const result = await runBench({ run: fakeRun, stageTimeoutMs: 10, runTimeoutMs: 60_000, attempts: 3 });

    strictEqual(result.stopped, 'stage-timeout');
    strictEqual(result.stages.length, 1, 'до explore дело не дошло — тот же виновник, что и раньше');
  });
});

describe('runBench: stage-env-repeat не теряет прогресс, если следующий этап уже разблокирован', () => {
  it('движок падал дважды подряд, но артефакт уже закрывает вход в explore — виток продолжает, не stage-env-repeat', async () => {
    let calls = 0;
    const fakeRun = {
      chunk: 1,
      attempt: 1,
      lastVerdict: null,
      blockers: () => [],
      blockerDetails: (stage: string) => (stage === 'explore' ? [] : []),
      cancel: () => {},
      recordDecision: () => {},
      runStage: async (stage: string): Promise<StageResult> => {
        if (stage !== 'intent') return { ok: true, finalText: 'готово', usage: emptyUsage(), note: 'готово', closedBy: 'runtime' } as StageResult;
        calls++;
        return { ok: false, finalText: '', usage: emptyUsage(), note: 'движок недоступен', envFailure: 'HTTP 400 fetch failed' };
      },
    } as unknown as Run;

    const result = await runBench({ run: fakeRun, stageTimeoutMs: 10_000, runTimeoutMs: 60_000, attempts: 3, stopAfterStage: 'explore' });

    strictEqual(calls, 2, 'ожидались попытка + один повтор до stage-env-repeat');
    strictEqual(result.stopped, 'snapshot-point', 'виток дошёл до explore вместо остановки stage-env-repeat');
    const [intent, explore] = result.stages;
    strictEqual(intent?.envFailure, 'HTTP 400 fetch failed');
    strictEqual(explore?.stage, 'explore');
  });

  it('следующий этап всё ещё блокирован — остановка «stage-env-repeat», как и раньше', async () => {
    const fakeRun = {
      chunk: 1,
      attempt: 1,
      lastVerdict: null,
      blockers: () => [],
      blockerDetails: (stage: string) => (stage === 'explore' ? [{ text: 'в intent.md осталось незаполненных мест: 5', blamed: 'intent' }] : []),
      cancel: () => {},
      runStage: async (): Promise<StageResult> => ({ ok: false, finalText: '', usage: emptyUsage(), note: 'движок недоступен', envFailure: 'HTTP 400 fetch failed' }),
    } as unknown as Run;

    const result = await runBench({ run: fakeRun, stageTimeoutMs: 10_000, runTimeoutMs: 60_000, attempts: 3 });

    strictEqual(result.stopped, 'stage-env-repeat');
    strictEqual(result.stages.length, 1);
  });

  it('обычный провал (не envFailure) не продолжает даже при разблокированном следующем этапе — суждение о модели остаётся настоящим', async () => {
    const fakeRun = {
      chunk: 1,
      attempt: 1,
      lastVerdict: null,
      blockers: () => [],
      blockerDetails: () => [],
      cancel: () => {},
      runStage: async (): Promise<StageResult> => ({ ok: false, finalText: '', usage: emptyUsage(), note: 'модель не заполнила бланк' }),
    } as unknown as Run;

    const result = await runBench({ run: fakeRun, stageTimeoutMs: 10_000, runTimeoutMs: 60_000, attempts: 3 });

    strictEqual(result.stopped, 'blocked');
    strictEqual(result.stages.length, 1);
  });
});
