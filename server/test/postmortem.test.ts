/**
 * Пост-виток отчёт «что съело итерации».
 *
 * Проверяется граница наблюдаемого: числа рантайм видел, причины ошибок — нет, и в
 * автогенерируемой части их быть не должно. Догадка, поданная числами, читается как факт.
 */

import { match, ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { RunMetrics } from '@sdlc-runner/shared';
import { emptyUsage } from '@sdlc-runner/shared';

import { postmortemBlock } from '../src/run/postmortem.ts';

const metrics = (over: Partial<RunMetrics> = {}): RunMetrics => ({
  stages: [
    { stage: 'chunk', runs: 2, usage: { ...emptyUsage(), inputTokens: 100, outputTokens: 50, costUsd: 0.12 }, durationMs: 65_000 },
  ],
  verdicts: { total: 2, red: 1 },
  redByCause: [{ kind: 'gate', count: 1 }],
  attemptsByChunk: [{ chunk: 1, attempts: 2 }],
  friction: [],
  ...over,
});

describe('пост-виток отчёт', () => {
  it('без единого прогона этапа секции нет вовсе', () => {
    // Пустая секция читалась бы как «итераций не потребовалось».
    strictEqual(postmortemBlock(metrics({ stages: [] })), null);
  });

  it('числа переносятся с указанием, что это наблюдения рантайма', () => {
    const b = postmortemBlock(metrics());
    ok(b !== null);
    match(b, /наблюдения рантайма/);
    match(b, /вердиктов: 2, из них красных: 1/);
    match(b, /chunk 1: 2/);
  });

  it('время и стоимость форматируются человекочитаемо', () => {
    const b = postmortemBlock(metrics());
    ok(b !== null);
    ok(b.includes('1 мин 5 с'));
    ok(b.includes('$0.1200'));
  });

  it('локальный маршрут не превращается в $0', () => {
    const b = postmortemBlock(
      metrics({
        stages: [{ stage: 'chunk', runs: 1, usage: { ...emptyUsage(), costUsd: null }, durationMs: 10 }],
      }),
    );
    ok(b?.includes('без стоимости'));
  });

  it('отсутствие разбивки по классам названо прямо, а не замолчано', () => {
    const b = postmortemBlock(metrics({ redByCause: [] }));
    ok(b !== null);
    match(b, /классы причин красного не определялись/i);
  });

  it('о причинах ошибок исполнителя блок не рассуждает', () => {
    const b = postmortemBlock(metrics());
    ok(b !== null);
    strictEqual(/потому что модель|исполнитель ошибся|причина в том/i.test(b), false);
  });
});
