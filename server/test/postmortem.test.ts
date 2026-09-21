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
    {
      stage: 'chunk',
      runs: 2,
      usage: { ...emptyUsage(), inputTokens: 300, outputTokens: 50, costUsd: 0.12 },
      durationMs: 65_000,
      turns: 3,
      offPathTurns: 1,
    },
  ],
  verdicts: { total: 2, red: 1 },
  redByCause: [{ kind: 'gate', count: 1 }],
  attemptsByChunk: [{ chunk: 1, attempts: 2 }],
  friction: [],
  gates: [],
  human: [],
  artifactGaps: [],
  chunkEvidence: [],
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
        stages: [
          { stage: 'chunk', runs: 1, usage: { ...emptyUsage(), costUsd: null }, durationMs: 10, turns: 1, offPathTurns: 0 },
        ],
      }),
    );
    ok(b?.includes('без стоимости'));
  });

  it('вход на ход считается делением входа на число ходов', () => {
    // 300 входных токенов за 3 хода — 100 на ход.
    const b = postmortemBlock(metrics());
    ok(b !== null);
    match(b, /\| chunk \| 2 \| 3 \| 1 \|/);
    ok(b.includes('100'));
  });

  it('без единого хода в этапе вход на ход — «н/д», а не деление на ноль', () => {
    const b = postmortemBlock(
      metrics({
        stages: [
          { stage: 'chunk', runs: 1, usage: { ...emptyUsage(), inputTokens: 50 }, durationMs: 10, turns: 0, offPathTurns: 0 },
        ],
      }),
    );
    ok(b !== null);
    match(b, /н\/д/);
  });

  it('снапшот старого формата (ходов 0 при ненулевых токенах) назван прямо', () => {
    const b = postmortemBlock(
      metrics({
        stages: [
          { stage: 'chunk', runs: 1, usage: { ...emptyUsage(), inputTokens: 50 }, durationMs: 10, turns: 0, offPathTurns: 0 },
        ],
      }),
    );
    ok(b !== null);
    match(b, /метрики записаны до появления этого счётчика/);
  });

  it('рублёвая валюта не считается как доллар', () => {
    const b = postmortemBlock(metrics(), 'RUB');
    ok(b !== null);
    ok(b.includes('₽'));
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
