/**
 * Маршрут независимого скана ревью (`run/reviewRoute.ts::decideReviewScan`) и настройка
 * `reviewModel` в конфиге раннера — норма verify редизайна «модель решает — рантайм
 * пишет» (`server/methodology/guided.md`, 2026-10-05/06):
 *
 *  - скан той же моделью, что исполнитель (маршрут chunk), — справочный (advisory),
 *    его находки вердикт не роняют;
 *  - отдельный `reviewModel`, отличный от исполнителя, — блокирующий, как прежде;
 *  - неизвестный id — ошибка конфига при загрузке, а не рецензент «не той» модели.
 */

import { strictEqual, throws } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { loadConfig, OPERATOR_PLACEHOLDER } from '../src/config/load.ts';
import type { ModelsConfig, ResolvedRoute } from '../src/config/schema.ts';
import { decideReviewScan, routeKey } from '../src/run/reviewRoute.ts';
import { withEnv } from './testUtils.ts';

const models: ModelsConfig = {
  providers: {
    local: { flow: 'loop', kind: 'openai-compat', baseUrl: 'http://localhost:1234/v1' },
    remote: { flow: 'loop', kind: 'openai-compat', baseUrl: 'https://api.example.com/v1' },
  },
  models: [
    { id: 'worker', provider: 'local', model: 'qwen3-8b', rank: 1 },
    { id: 'critic', provider: 'remote', model: 'gpt-5-mini', rank: 5 },
    // Другая ЗАПИСЬ той же provider:model — сравнение идёт по provider:model, не по id.
    { id: 'worker-alias', provider: 'local', model: 'qwen3-8b', rank: 2 },
  ],
};

/** Маршрут минимальной формы: решение читает только `provider`/`model`. */
function route(provider: string, model: string): ResolvedRoute {
  return { provider, model } as unknown as ResolvedRoute;
}

const executor = route('local', 'qwen3-8b');

describe('decideReviewScan', () => {
  it('без reviewModel скан идёт маршрутом этапа verify, как прежде', () => {
    const verify = route('remote', 'gpt-5-mini');
    const decision = decideReviewScan({ reviewModelId: undefined, models, executor, verifyRoute: verify });
    strictEqual(decision.route, verify, 'маршрут не подменяется');
    strictEqual(decision.blocking, true, 'рецензент не исполнитель — находки блокирующие');
  });

  it('скан той же моделью, что исполнитель, — справочный (advisory)', () => {
    const decision = decideReviewScan({
      reviewModelId: undefined, models, executor, verifyRoute: route('local', 'qwen3-8b'),
    });
    strictEqual(decision.blocking, false, 'саморевью уровнем вердикта не является');
  });

  it('reviewModel, отличный от исполнителя, — блокирующий скан по этому маршруту', () => {
    const decision = decideReviewScan({ reviewModelId: 'critic', models, executor, verifyRoute: executor });
    strictEqual(decision.route.modelId, 'critic');
    strictEqual(decision.route.provider, 'remote');
    strictEqual(decision.blocking, true);
  });

  it('reviewModel той же provider:model, что исполнитель, — тоже advisory', () => {
    const decision = decideReviewScan({ reviewModelId: 'worker-alias', models, executor, verifyRoute: executor });
    strictEqual(decision.route.modelId, 'worker-alias', 'идёт именно заданный маршрут');
    strictEqual(decision.blocking, false, 'сравнение по provider:model, а не по id записи');
  });

  it('неизвестный reviewModel — ошибка, а не молчаливый откат на маршрут этапа', () => {
    throws(
      () => decideReviewScan({ reviewModelId: 'ghost', models, executor, verifyRoute: executor }),
      /ghost/,
    );
  });

  it('routeKey — ровно provider:model, как guided.modelId', () => {
    strictEqual(routeKey(route('local', 'qwen3-8b')), 'local:qwen3-8b');
  });
});

// ── загрузка конфига ─────────────────────────────────────────────────────────

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** Каталог конфигурации с `reviewModel` в runner.json и записью `critic` в models.json. */
function configDir(reviewModel: string | undefined): string {
  const dir = mkdtempSync(join(tmpdir(), 'sdlc-reviewroute-'));
  dirs.push(dir);
  writeFileSync(
    join(dir, 'runner.json'),
    JSON.stringify({
      port: 8030,
      operator: OPERATOR_PLACEHOLDER,
      skillsDir: '~/.claude/skills',
      agentsDir: '~/.claude/agents',
      methodologyDir: '~/Code/Agent-SDLC',
      ...(reviewModel === undefined ? {} : { reviewModel }),
      limits: { maxToolResultBytes: 60000 },
    }),
    'utf8',
  );
  writeFileSync(
    join(dir, 'models.json'),
    JSON.stringify({
      providers: { remote: { flow: 'loop', kind: 'openai-compat', baseUrl: 'https://api.example.com/v1' } },
      models: [{ id: 'critic', provider: 'remote', model: 'gpt-5-mini', rank: 5 }],
    }),
    'utf8',
  );
  mkdirSync(join(dir, 'projects'));
  writeFileSync(
    join(dir, 'projects', 'p.json'),
    JSON.stringify({ name: 'p', projectRoot: dir, activeProfile: 'x', maxBudgetUsd: 1, profiles: {} }),
    'utf8',
  );
  return dir;
}

describe('reviewModel в конфиге раннера', () => {
  it('известный id загружается и доступен раннеру', () => {
    const cfg = loadConfig(configDir('critic'));
    strictEqual(cfg.runner.reviewModel, 'critic');
  });

  it('неизвестный id — ошибка загрузки с именем модели, а не виток с чужим рецензентом', () => {
    throws(() => loadConfig(configDir('ghost')), /ghost/);
  });

  it('отсутствие настройки — прежнее поведение скана (маршрут этапа verify)', () => {
    strictEqual(loadConfig(configDir(undefined)).runner.reviewModel, undefined);
  });

  it('SDLC_REVIEW_MODEL переопределяет runner.json и тоже проверяется', () => {
    withEnv('SDLC_REVIEW_MODEL', 'critic', () => {
      strictEqual(loadConfig(configDir(undefined)).runner.reviewModel, 'critic');
    });
    withEnv('SDLC_REVIEW_MODEL', 'ghost', () => {
      throws(() => loadConfig(configDir(undefined)), /ghost/);
    });
  });
});
