import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, it } from 'node:test';
import type { Verdict } from '@sdlc-runner/shared';
import { WitokPaths } from '../src/artifacts/paths.ts';
import { parseGates } from '../src/gates/gatesFile.ts';
import { applyEnvRetryBudget, envRetryBudget, envRetryStatePath } from '../src/run/envRetryBudget.ts';

const root = mkdtempSync(join(tmpdir(), 'sdlc-env-retry-'));
after(() => rmSync(root, { recursive: true, force: true }));
let sequence = 0;
const paths = () => new WitokPaths(root, `case-${++sequence}`);
const blocked: Verdict = { passed: false, action: 'blocked_env', reasons: ['java: command not found'] };

it('третий средовой красный эскалирует, сохраняя причину среды', () => {
  const p = paths();
  const outcomes = [1, 2, 3].map(i => applyEnvRetryBudget(p, 1, `verify-${i}`, blocked, 3));
  deepStrictEqual(outcomes.map(v => v.action), ['blocked_env', 'blocked_env', 'escalate']);
  strictEqual(outcomes[2]?.passed, false);
  ok(outcomes[2]?.reasons.includes('java: command not found'));
  ok(outcomes[2]?.reasons.some(r => r.includes('среда не восстановлена за 3')));
});

it('пересчёт внутри прогона не расходует бюджет, в том числе после достижения лимита', () => {
  const p = paths();
  for (let i = 0; i < 5; i++) strictEqual(applyEnvRetryBudget(p, 1, 'first', blocked, 2).action, 'blocked_env');
  strictEqual(applyEnvRetryBudget(p, 1, 'second', blocked, 2).action, 'escalate');
  strictEqual(applyEnvRetryBudget(p, 1, 'second', blocked, 2).action, 'escalate');
});

it('новый объект путей после рестарта продолжает сохранённую серию', () => {
  const p = paths();
  applyEnvRetryBudget(p, 1, 'before-restart', blocked, 2);
  const restored = new WitokPaths(root, p.slug);
  strictEqual(applyEnvRetryBudget(restored, 1, 'after-restart', blocked, 2).action, 'escalate');
});

it('любой несредовой исход сбрасывает серию', () => {
  for (const verdict of [
    { passed: true, action: 'continue', reasons: [] },
    { passed: false, action: 'retry', reasons: ['defect'] },
    { passed: false, action: 'escalate', reasons: ['no progress'] },
  ] satisfies Verdict[]) {
    const p = paths();
    applyEnvRetryBudget(p, 1, 'first', blocked, 2);
    deepStrictEqual(applyEnvRetryBudget(p, 1, 'other', verdict, 2), verdict);
    strictEqual(applyEnvRetryBudget(p, 1, 'next', blocked, 2).action, 'blocked_env');
  }
});

it('изменение результата того же прогона заменяет его вклад', () => {
  const p = paths();
  applyEnvRetryBudget(p, 1, 'first', blocked, 3);
  applyEnvRetryBudget(p, 1, 'second', blocked, 3);
  applyEnvRetryBudget(p, 1, 'second', { passed: true, action: 'continue', reasons: [] }, 3);
  strictEqual(applyEnvRetryBudget(p, 1, 'third', blocked, 3).action, 'blocked_env');
});

it('новый chunk и другой виток имеют собственные серии', () => {
  const p = paths();
  applyEnvRetryBudget(p, 1, 'first', blocked, 2);
  strictEqual(applyEnvRetryBudget(p, 2, 'next-chunk', blocked, 2).action, 'blocked_env');
  strictEqual(applyEnvRetryBudget(paths(), 1, 'other-run', blocked, 2).action, 'blocked_env');
});

it('повреждённое состояние не обнуляет бюджет молча', () => {
  for (const value of ['{broken', 'null', '{"version":1,"chunk":1,"cycle":"x","before":0,"count":-1}']) {
    const p = paths();
    const file = envRetryStatePath(p, 1);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, value);
    throws(() => applyEnvRetryBudget(p, 1, 'next', blocked, 3), /Состояние средовых повторов/);
    strictEqual(readFileSync(file, 'utf8'), value);
  }
});

it('бюджет берётся только из включённой настройки с целым положительным числом', () => {
  const gates = (value: string, enabled = 'да') => parseGates(`## Набор\n\n| Гейт | Вкл | Где отчитывается | Чем реализован |\n|---|---|---|---|\n| Бюджет средовых повторов | ${enabled} | вне витка | ${value} |\n`);
  strictEqual(envRetryBudget(null), 3);
  strictEqual(envRetryBudget(gates('2')), 2);
  strictEqual(envRetryBudget(gates('1')), 1);
  strictEqual(envRetryBudget(gates('100')), 20);
  strictEqual(envRetryBudget(gates('2', 'нет')), 3);
  for (const value of ['0', '-1', '2.5', 'долг до 2027', '‹число›']) strictEqual(envRetryBudget(gates(value)), 3);
});
