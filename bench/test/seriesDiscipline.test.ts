import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cellAdmission, controlRowProblem, formatSourceDiff, gpuWaitDecision, pilotGate, shiftLabel, sourceDiff, sourceFingerprint } from '../src/seriesDiscipline.ts';
import type { PacketProfile } from '../src/contextPreflight.ts';

const q = (passed: boolean, okCases = 12, total = 12) => ({ passed, elapsedMs: 0, compatible: true,
  cases: Array.from({ length: total }, (_, i) => ({ name: `c${i}`, repetition: 1, passed: i < okCases })) });
const passport = (secondsPerDecision: number) => ({ decisions: 10, completionTokens: 1000, promptTokens: 10000, elapsedMs: 1, secondsPerDecision, tokensPerSecond: 10, reasoningShare: 0 });

describe('пилот-гейт перед матрицей', () => {
  it('без пилота матрица не стартует', () => {
    const verdict = pilotGate({ cells: [] });
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /≥3 повторов/);
  });
  it('требует ≥3 повторов одной пары и хотя бы один успех', () => {
    const two = pilotGate({ cells: [{ model: 'm', task: 't', success: true }, { model: 'm', task: 't', success: true }] });
    assert.equal(two.ok, false);
    assert.match(two.reason, /1\/2|2\/2/);
    const three = pilotGate({ cells: [{ model: 'm', task: 't', success: false }, { model: 'm', task: 't', success: true }, { model: 'm', task: 't', success: null }] });
    assert.equal(three.ok, true);
    assert.match(three.reason, /m\|t — 1\/3/);
  });
  it('повторы разных задач одной модели пилотом не считаются', () => {
    const verdict = pilotGate({ cells: [{ model: 'm', task: 'a', success: true }, { model: 'm', task: 'b', success: true }, { model: 'm', task: 'c', success: true }] });
    assert.equal(verdict.ok, false);
  });
});

describe('отпечаток исходников между сериями', () => {
  it('называет изменённые, добавленные и удалённые модули', () => {
    const root = mkdtempSync(join(tmpdir(), 'discipline-'));
    mkdirSync(join(root, 'server/src'), { recursive: true });
    writeFileSync(join(root, 'server/src/a.ts'), 'a');
    writeFileSync(join(root, 'server/src/b.ts'), 'b');
    const before = sourceFingerprint(root, ['server/src']);
    writeFileSync(join(root, 'server/src/a.ts'), 'a2');
    writeFileSync(join(root, 'server/src/c.ts'), 'c');
    const after = sourceFingerprint(root, ['server/src']);
    assert.notEqual(before.digest, after.digest);
    const diff = sourceDiff(before, after);
    assert.deepEqual(diff, { changed: ['server/src/a.ts'], added: ['server/src/c.ts'], removed: [], modules: 2 });
    assert.match(formatSourceDiff(diff), /изменено модулей: 2 \(правило журнала/);
    assert.equal(formatSourceDiff(sourceDiff(after, after)), 'исходники не менялись относительно предыдущей серии');
  });
});

describe('допуск клетки до загрузки модели', () => {
  const profile: PacketProfile = { version: 1, task: 't', builtFrom: [], builtAt: 'now', packets: [
    { stage: 'ask', schema: 'guided_question_resolution', samples: 3, completeSamples: 3, measuredSamples: 3, minPromptTokens: 15161, p50PromptTokens: 15161, maxPromptTokens: 15161, p90CompletionTokens: 600 }] };

  it('квалификация FAIL — класс preflight, даже если транспорт совместим', () => {
    const verdict = cellAdmission({ qualification: q(false, 8), passport: passport(3) });
    assert.equal(verdict.admit, false);
    if (!verdict.admit) { assert.equal(verdict.failureClass, 'preflight'); assert.match(verdict.reason, /FAIL \(8\/12\)/); }
  });
  it('паспорт выше потолка стенных часов — preflight', () => {
    const verdict = cellAdmission({ qualification: q(true), passport: passport(12), wallclock: { referenceDecisionSeconds: 3, maxScale: 3 } });
    assert.equal(verdict.admit, false);
    if (!verdict.admit) assert.match(verdict.reason, /×4\.0 опоры при потолке ×3/);
  });
  it('паспорт в пределах потолка — допуск с масштабом в нотах', () => {
    const verdict = cellAdmission({ qualification: q(true), passport: passport(6), wallclock: { referenceDecisionSeconds: 3, maxScale: 3 } });
    assert.equal(verdict.admit, true);
    if (verdict.admit) assert.deepEqual(verdict.notes, ['стенные часы ×2']);
  });
  it('арифметика контекста: пакет не влезает в окно — preflight; шире окно — допуск', () => {
    const tight = cellAdmission({ qualification: q(true), passport: null, context: { profile, contextWindow: 16384 } });
    assert.equal(tight.admit, false);
    if (!tight.admit) assert.match(tight.reason, /ask\/guided_question_resolution окно 16384 − пакет 15161 − 512 = 711/);
    const wide = cellAdmission({ qualification: q(true), passport: null, context: { profile, contextWindow: 32768 } });
    assert.equal(wide.admit, true);
    if (wide.admit) assert.deepEqual(wide.notes, ['паспорта скорости нет — лимиты без масштаба']);
  });
});

describe('ожидание GPU и контроль серии', () => {
  it('исчерпанный бюджет ожидания — пауза, не остановка; остановка только по часам серии', () => {
    assert.deepEqual(gpuWaitDecision({ waitedMs: 1000, budgetMs: 900000, deadlineMs: 10, nowMs: 5 }), { action: 'wait' });
    const paused = gpuWaitDecision({ waitedMs: 900000, budgetMs: 900000, deadlineMs: 10, nowMs: 5 });
    assert.equal(paused.action, 'pause');
    assert.equal(gpuWaitDecision({ waitedMs: 0, budgetMs: 900000, deadlineMs: 5, nowMs: 5 }).action, 'stop');
  });
  it('серия без сильного контрольного ряда не проходит', () => {
    assert.match(controlRowProblem({ models: ['a'] }) ?? '', /контрольного ряда/);
    assert.match(controlRowProblem({ models: ['a'], control: ['b'] }) ?? '', /не входят в models: b/);
    assert.equal(controlRowProblem({ models: ['a', 'b'], control: ['b'] }), null);
  });
  it('сдвиг класса отказа при n=1 не утверждается', () => {
    assert.equal(shiftLabel('budget', 'model', 1), 'budget → model (n=1 — не сдвиг)');
    assert.equal(shiftLabel('budget', 'model', 2), 'budget → model');
    assert.equal(shiftLabel('model', 'model', 1), '= model');
    assert.equal(shiftLabel(undefined, 'model', 3), '—');
  });
});
