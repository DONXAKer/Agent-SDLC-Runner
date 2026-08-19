/**
 * Эскалация модели внутри витка.
 *
 * Две планки: срабатывать по ОДНОМУ И ТОМУ ЖЕ непройденному пункту (иначе эскалация
 * наступает от смены симптомов, то есть когда работа как раз идёт) и никогда не предлагать
 * подъём, ломающий правило рецензента.
 */

import { strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ModelDef } from '../src/config/schema.ts';
import { stuckClaims, suggestEscalation } from '../src/run/escalation.ts';

const models: ModelDef[] = [
  { id: 'haiku', provider: 'claude-sdk', model: 'h', rank: 1 },
  { id: 'sonnet', provider: 'claude-sdk', model: 's', rank: 2 },
  { id: 'opus', provider: 'claude-sdk', model: 'o', rank: 3 },
];

const input = (over: Record<string, unknown> = {}) => ({
  failedClaimsByAttempt: [['c1'], ['c1']],
  chunkModelId: 'haiku',
  chunkRank: 1,
  verifyModelId: 'opus',
  verifyRank: 3,
  models,
  ...over,
});

describe('застрявшие пункты приёмки', () => {
  it('первая попытка ничего не даёт: сравнивать не с чем', () => {
    strictEqual(stuckClaims([['c1']]).length, 0);
  });

  it('пункт, проваленный дважды подряд, найден', () => {
    strictEqual(stuckClaims([['c1', 'c2'], ['c1']]).join(','), 'c1');
  });

  it('смена симптомов застреванием не считается', () => {
    strictEqual(stuckClaims([['c1'], ['c2']]).length, 0);
  });
});

describe('предложение поднять модель', () => {
  it('без застрявших пунктов эскалации нет', () => {
    const e = suggestEscalation(input({ failedClaimsByAttempt: [['c1'], ['c2']] }));
    strictEqual(e.kind, 'none');
  });

  it('берётся МИНИМАЛЬНАЯ модель строго сильнее текущей', () => {
    const e = suggestEscalation(input());
    strictEqual(e.kind, 'suggest');
    if (e.kind === 'suggest') strictEqual(e.toModelId, 'sonnet');
  });

  it('подъём, ломающий правило рецензента, не предлагается', () => {
    // chunk=sonnet(2), verify=opus(3): следующая сильнее — opus(3), но тогда verify
    // перестал бы быть СТРОГО сильнее chunk.
    const e = suggestEscalation(input({ chunkModelId: 'sonnet', chunkRank: 2 }));
    strictEqual(e.kind, 'blocked');
    if (e.kind === 'blocked') {
      strictEqual(e.why.includes('строго сильнее'), true);
      strictEqual(e.why.includes('оба этапа'), true);
    }
  });

  it('когда поднимать некуда, это сказано вслух, а не замолчано', () => {
    const e = suggestEscalation(input({ chunkModelId: 'opus', chunkRank: 3, verifyRank: 9 }));
    strictEqual(e.kind, 'blocked');
    if (e.kind === 'blocked') strictEqual(e.why.includes('поднимать некуда'), true);
  });

  it('обоснование называет застрявшие пункты поимённо', () => {
    const e = suggestEscalation(input({ failedClaimsByAttempt: [['c1', 'c7'], ['c1', 'c7']] }));
    if (e.kind === 'suggest') {
      strictEqual(e.claims.join(','), 'c1,c7');
      strictEqual(e.why.includes('c1, c7'), true);
    } else {
      throw new Error('ожидалось предложение');
    }
  });
});
