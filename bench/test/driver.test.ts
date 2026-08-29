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

import type { Verdict } from '@sdlc-runner/shared';

import { attemptCeiling, decideAfterVerify } from '../src/driver.ts';

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
