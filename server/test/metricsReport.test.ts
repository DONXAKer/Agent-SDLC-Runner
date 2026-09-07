/**
 * Персистентный отчёт метрик витка (`metrics.md`) — человекочитаемый рендер снапшота.
 *
 * Проверяются оба полюса: «нечего рассказать» (секции нет вовсе) и полный набор секций.
 * Числа — наблюдения рантайма: блок не рассуждает о причинах, только переносит счётчики.
 */

import { match, ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { RunMetrics } from '@sdlc-runner/shared';
import { emptyUsage } from '@sdlc-runner/shared';

import { metricsBlock } from '../src/run/metricsReport.ts';

const metrics = (over: Partial<RunMetrics> = {}): RunMetrics => ({
  stages: [],
  verdicts: { total: 0, red: 0 },
  redByCause: [],
  attemptsByChunk: [],
  friction: [],
  gates: [
    { gate: 'Сборка', runs: 3, red: 1, skippedWhileEnabled: 1, durationMs: 65_000 },
    { gate: 'Тесты', runs: 3, red: 0, skippedWhileEnabled: 0, durationMs: 30_000 },
  ],
  human: [
    { stage: 'chunk', questions: 2, approvals: 4, waitMs: 90_000 },
    { stage: 'plan', questions: 0, approvals: 1, waitMs: 5_000 },
  ],
  artifactGaps: [{ artifact: 'plan.md', placeholders: 3 }],
  ...over,
});

describe('metrics.md: рендер снапшота метрик', () => {
  it('ни одной секции — блока нет вовсе', () => {
    strictEqual(
      metricsBlock(metrics({ gates: [], human: [], artifactGaps: [] })),
      null,
    );
  });

  it('все три секции на месте и несут свои числа', () => {
    const b = metricsBlock(metrics());
    ok(b !== null);
    match(b, /## Метрики витка \(посчитано рантаймом\)/);
    match(b, /\| Сборка \| 3 \| 1 \| 1 \|/);
    match(b, /\| Тесты \| 3 \| 0 \| 0 \|/);
    match(b, /\| chunk \| 2 \| 4 \|/);
    match(b, /\| plan \| 0 \| 1 \|/);
    match(b, /\| plan\.md \| 3 \|/);
  });

  it('время прогонов и ожидания форматируется человекочитаемо', () => {
    const b = metricsBlock(metrics());
    ok(b !== null);
    ok(b.includes('1 мин 5 с'), 'время гейта');
    ok(b.includes('1 мин 30 с'), 'время ожидания человека');
  });

  it('пустые секции не рисуются: только гейты — только таблица гейтов', () => {
    const b = metricsBlock(metrics({ human: [], artifactGaps: [] }));
    ok(b !== null);
    strictEqual(b.includes('| Этап | Вопросов |'), false);
    strictEqual(b.includes('Незаполненных мест'), false);
    match(b, /\| Гейт \| Прогонов \|/);
  });

  it('о причинах провалов блок не рассуждает', () => {
    const b = metricsBlock(metrics());
    ok(b !== null);
    strictEqual(/потому что модель|исполнитель ошибся|причина в том/i.test(b), false);
  });
});

describe('metrics.md: связь с metrics.json', () => {
  it('стоимость этапов в этот блок не входит — она живёт в пост-виток отчёте', () => {
    const b = metricsBlock(
      metrics({
        stages: [
          { stage: 'chunk', runs: 1, usage: { ...emptyUsage(), costUsd: 0.5 }, durationMs: 10 },
        ],
      }),
    );
    ok(b !== null);
    strictEqual(b.includes('$'), false, 'цен здесь нет — рендер из того же снапшота, не второй отчёт');
  });
});
