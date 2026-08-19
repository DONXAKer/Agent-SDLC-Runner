/**
 * Ансамбль маршрутов на этапе.
 *
 * Главная планка — правило рецензента на СПИСКАХ: слабейший рецензент обязан быть строго
 * сильнее сильнейшего исполнителя. Иначе ансамбль становится способом протащить слабого
 * рецензента рядом с сильным: правило выполнялось бы «в среднем», а слабый всё равно
 * голосовал бы.
 */

import { ok, strictEqual, throws } from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ModelsConfig, ProjectConfig } from '../src/config/schema.ts';
import { checkReviewerRule, resolveProfile, resolveStartableProfile } from '../src/config/profiles.ts';

const models: ModelsConfig = {
  providers: { p: { flow: 'loop', kind: 'openai-compat', baseUrl: 'http://x' } },
  models: [
    { id: 'weak', provider: 'p', model: 'w', rank: 1 },
    { id: 'mid', provider: 'p', model: 'm', rank: 2 },
    { id: 'strong', provider: 'p', model: 's', rank: 3 },
  ],
} as unknown as ModelsConfig;

const project = (stages: Record<string, string | string[]>): ProjectConfig =>
  ({
    name: 'p',
    projectRoot: '/tmp',
    activeProfile: 'x',
    maxBudgetUsd: 1,
    profiles: { x: { label: 'x', stages } },
  }) as unknown as ProjectConfig;

const allStages = (over: Record<string, string | string[]>) => ({
  intent: 'weak',
  explore: 'weak',
  ask: 'weak',
  plan: 'weak',
  chunk: 'weak',
  verify: 'strong',
  handoff: 'weak',
  ...over,
});

describe('маршруты этапа', () => {
  it('строка разворачивается в список из одного: старые конфиги не ломаются', () => {
    const p = resolveProfile(project(allStages({})), models, 'x');
    strictEqual(p.ensemble.verify.length, 1);
    strictEqual(p.routes.verify.modelId, 'strong');
  });

  it('список даёт несколько маршрутов, основной — первый', () => {
    const p = resolveProfile(project(allStages({ verify: ['strong', 'mid'] })), models, 'x');
    strictEqual(p.ensemble.verify.length, 2);
    strictEqual(p.routes.verify.modelId, 'strong');
  });

  it('неизвестная модель в списке названа поимённо', () => {
    throws(
      () => resolveProfile(project(allStages({ verify: ['strong', 'нет-такой'] })), models, 'x'),
      /нет-такой/,
    );
  });
});

describe('правило рецензента на списках', () => {
  it('ансамбль рецензентов сильнее исполнителя проходит', () => {
    const p = resolveProfile(project(allStages({ verify: ['strong', 'mid'] })), models, 'x');
    strictEqual(checkReviewerRule(p).length, 0);
  });

  it('слабый рецензент рядом с сильным НЕ проходит', () => {
    // chunk=mid(2), verify=[strong(3), weak(1)] — слабейший рецензент слабее исполнителя.
    const p = resolveProfile(
      project(allStages({ chunk: 'mid', verify: ['strong', 'weak'] })),
      models,
      'x',
    );
    const problems = checkReviewerRule(p);
    strictEqual(problems.length, 1);
    ok(problems[0]?.includes('слабейший verify'));
  });

  it('сильный исполнитель в ансамбле chunk тоже учитывается', () => {
    // chunk=[weak, strong] — сильнейший исполнитель равен рецензенту, строгости нет.
    const p = resolveProfile(
      project(allStages({ chunk: ['weak', 'strong'], verify: 'strong' })),
      models,
      'x',
    );
    strictEqual(checkReviewerRule(p).length, 1);
  });

  it('виток с нарушенным правилом не стартует', () => {
    throws(
      () =>
        resolveStartableProfile(
          project(allStages({ chunk: 'mid', verify: ['strong', 'weak'] })),
          models,
          'x',
        ),
      /рецензент этапа 6 не сильнее/,
    );
  });
});
