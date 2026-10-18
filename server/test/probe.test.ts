/**
 * `formatProbe` — итоговая фраза обязана называть верный протокол (tool-calling у
 * исполнителя chunk, закрытый текстовый вопрос у рецензента verify), а не всегда
 * «не дошла до вызова инструмента»: `REVIEWER_PROBE_CASES` вообще не вызывают инструменты
 * (найдено живьём, 2026-09-27: gemma4-26b-a4b провалила рецензентский кейс, а итоговая
 * фраза до этой правки всё равно винила «вызов инструментов»).
 */

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formatProbe, probeModel } from '../src/probe.ts';
import type { ProbeCase, ProbeReport } from '../src/probe.ts';
import type { ChatProvider } from '../src/provider/ChatProvider.ts';

const stubProvider: ChatProvider = { name: 'stub', chat: async () => ({ text: '', toolCalls: [], finishReason: 'stop', usage: {} } as never) };
const fakeCase: ProbeCase = { name: 'кейс', run: async () => ({ ok: true, detail: 'ok' }) };

const caseResult = (over: Partial<ProbeReport['cases'][number]> = {}) => ({
  name: 'кейс',
  ok: true,
  detail: 'ok',
  env: false,
  timedOut: false,
  durationMs: 1,
  ...over,
});

describe('formatProbe: роль решает формулировку итога', () => {
  it('role не задан (умолчание) — фраза про исполнителя chunk, как раньше', () => {
    const report: ProbeReport = { model: 'm', cases: [caseResult({ ok: false })], passed: false, envBlocked: false };
    ok(formatProbe(report).includes('не дошла до вызова инструментов'), formatProbe(report));
  });

  it('role: "chunk" явно — та же фраза про инструменты, зелёный и красный варианты', () => {
    const green: ProbeReport = { model: 'm', cases: [caseResult()], passed: true, envBlocked: false, role: 'chunk' };
    const red: ProbeReport = { model: 'm', cases: [caseResult({ ok: false })], passed: false, envBlocked: false, role: 'chunk' };
    ok(formatProbe(green).includes('доходит до корректных вызовов инструментов'), formatProbe(green));
    ok(formatProbe(red).includes('не дошла до вызова инструментов'), formatProbe(red));
  });

  it('role: "verify" — фраза про закрытый вопрос, НЕ про вызов инструментов (bug 2026-09-27)', () => {
    const green: ProbeReport = { model: 'm', cases: [caseResult()], passed: true, envBlocked: false, role: 'verify' };
    const red: ProbeReport = { model: 'm', cases: [caseResult({ ok: false })], passed: false, envBlocked: false, role: 'verify' };
    ok(formatProbe(green).includes('закрытого вопроса'), formatProbe(green));
    ok(formatProbe(red).includes('закрытого вопроса'), formatProbe(red));
    ok(!formatProbe(red).includes('вызова инструментов'), formatProbe(red));
  });

  it('envBlocked побеждает role в любом случае — среда, не роль', () => {
    const report: ProbeReport = { model: 'm', cases: [caseResult({ ok: false, env: true })], passed: false, envBlocked: true, role: 'verify' };
    deepStrictEqual(formatProbe(report).includes('НЕ ИЗМЕРЕНА'), true);
  });
});

describe('probeModel: роль — явный параметр, не вывод по ссылочному равенству', () => {
  it('явный role: "verify" побеждает независимо от того, тот ли это массив cases — фикс регрессии retry', async () => {
    // Прежде роль вычислялась как `args.cases === REVIEWER_PROBE_CASES` — сравнение по
    // ссылке ломалось ровно там, где и требовалось: `bench/src/preflight.ts::checkModel`
    // передаёт на retry НОВЫЙ массив `[retryCase]` (не ту же ссылку), и роль рецензента
    // молча откатывалась к `'chunk'` (code-review-all, 2026-09-28, найдено в РЕАЛЬНОМ
    // вызывающем коде, не гипотетически).
    const report = await probeModel({ provider: stubProvider, model: 'm', caseTimeoutMs: 1000, cases: [fakeCase], role: 'verify' });
    strictEqual(report.role, 'verify');
  });

  it('role не передан — прежнее поведение по ссылке сохранено (обратная совместимость)', async () => {
    const report = await probeModel({ provider: stubProvider, model: 'm', caseTimeoutMs: 1000, cases: [fakeCase] });
    strictEqual(report.role, 'chunk');
  });

  it('явный role: "chunk" на пустом наборе (умолчание CASES) — не ломается', async () => {
    const report = await probeModel({ provider: stubProvider, model: 'm', caseTimeoutMs: 1000, cases: [fakeCase], role: 'chunk' });
    strictEqual(report.role, 'chunk');
  });
});
