import { ok, strictEqual, throws } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadConfig } from '../src/config/load.ts';
import { ProfileError, resolveProfile, resolveStartableProfile } from '../src/config/profiles.ts';
import type { ModelsConfig, ProjectConfig } from '../src/config/schema.ts';

const models: ModelsConfig = {
  providers: {
    'claude-sdk': { flow: 'sdk', kind: 'claude-agent-sdk' },
    ollama: { flow: 'loop', kind: 'openai-compat', baseUrl: 'http://localhost:11434/v1' },
  },
  models: [
    { id: 'claude-sdk:opus', provider: 'claude-sdk', model: 'opus', rank: 90 },
    { id: 'claude-sdk:sonnet', provider: 'claude-sdk', model: 'sonnet', rank: 70 },
    { id: 'ollama:big', provider: 'ollama', model: 'big', rank: 30 },
    { id: 'ollama:small', provider: 'ollama', model: 'small', rank: 20 },
  ],
};

function project(chunk: string, verify: string): ProjectConfig {
  const stages = {
    intent: 'ollama:small',
    explore: 'ollama:small',
    ask: 'ollama:small',
    plan: 'ollama:small',
    chunk,
    verify,
    handoff: 'ollama:small',
  };
  return {
    name: 'demo',
    projectRoot: 'D:/work/demo',
    activeProfile: 'p',
    maxBudgetUsd: 1,
    profiles: { p: { label: 'p', stages } },
  };
}

describe('назначение моделей этапам не зависит от ранга', () => {
  it('принимает модель verify слабее модели chunk', () => {
    const p = resolveStartableProfile(project('ollama:big', 'ollama:small'), models, 'p');
    strictEqual(p.routes.verify.rank, 20);
    strictEqual(p.routes.chunk.rank, 30);
  });

  it('принимает профиль, где рецензент сильнее исполнителя', () => {
    const p = resolveStartableProfile(project('ollama:small', 'ollama:big'), models, 'p');
    strictEqual(p.routes.verify.rank, 30);
    strictEqual(p.routes.chunk.rank, 20);
  });

  it('allows equal reviewer rank', () => {
    const p = resolveStartableProfile(project('ollama:small', 'ollama:small'), models, 'p');
    strictEqual(p.routes.verify.modelId, 'ollama:small');
  });

  it('смешанный профиль — санкционированный выход', () => {
    const p = resolveStartableProfile(project('ollama:small', 'claude-sdk:opus'), models, 'p');
    strictEqual(p.routes.chunk.flow, 'loop');
    strictEqual(p.routes.verify.flow, 'sdk');
  });
});

describe('разрешение профиля', () => {
  it('флоу выводится из провайдера, отдельной настройки нет', () => {
    const p = resolveProfile(project('ollama:small', 'ollama:big'), models, 'p');
    strictEqual(p.routes.intent.flow, 'loop');
    strictEqual(p.routes.intent.providerDef.kind, 'openai-compat');
  });

  it('копит все проблемы разом, а не падает на первой', () => {
    const bad = project('нет-такой', 'тоже-нет');
    try {
      resolveProfile(bad, models, 'p');
      ok(false, 'ожидалась ошибка');
    } catch (e) {
      ok(e instanceof ProfileError);
      strictEqual(e.problems.length, 2);
    }
  });

  it('неизвестный профиль называет известные', () => {
    throws(
      () => resolveProfile(project('ollama:small', 'ollama:big'), models, 'нет'),
      /Известные: p/,
    );
  });
});

describe('разрешение контекста шага', () => {
  it('по умолчанию включает контекст для stepFill и уважает явное отключение', () => {
    const stepModels: ModelsConfig = {
      ...models,
      models: models.models.map((model) => model.id === 'ollama:small' ? { ...model, stepFill: true } : model),
    };
    const defaultOn = resolveProfile(project('ollama:small', 'ollama:big'), stepModels, 'p');
    strictEqual(defaultOn.routes.chunk.stepFill, true);
    strictEqual(defaultOn.routes.chunk.stepContext, true);

    const optedOut: ModelsConfig = {
      ...stepModels,
      models: stepModels.models.map((model) => model.id === 'ollama:small' ? { ...model, stepContext: false } : model),
    };
    const disabled = resolveProfile(project('ollama:small', 'ollama:big'), optedOut, 'p');
    strictEqual(disabled.routes.chunk.stepContext, false);
  });
});

describe('конфиги репозитория', () => {
  it('поставляемые config/*.json грузятся и профили в них стартуемы', () => {
    const cfg = loadConfig();
    const demo = cfg.projects.get('example');
    ok(demo !== undefined, 'проект example должен быть в config/projects');
    for (const name of Object.keys(demo.profiles)) {
      const p = resolveStartableProfile(demo, cfg.models, name);
      strictEqual(Object.keys(p.routes).length, 7);
    }
  });
});
