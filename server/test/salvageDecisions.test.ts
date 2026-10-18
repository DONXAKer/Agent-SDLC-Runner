/**
 * Спасение артефакта из текста (`Run.salvageFromText`) не стирает поля решений человека.
 *
 * Живой прогон (ollama:gpt-oss-20b-agent, rename-field, 2026-09-24): журнал chunk'а на
 * 5 834 токена напечатан текстом, рантайм превратил его в `Write` целиком — без строки
 * «Подтвердил», которую модель в пересказ не перенесла, — и гейт отклонил запись как
 * «стирание поля решения человека». Ход и попытка сгорели, хотя содержимое было годным.
 * Теперь стёртое поле возвращается ДО гейта (это запись рантайма, ручка
 * `restoreErasedDecisions` тут ни при чём), а невосстановимый блок пропускается с нотой.
 */

import { ok, strictEqual } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import type { StageId } from '@sdlc-runner/shared';
import { STAGE_ORDER } from '@sdlc-runner/shared';

import { AskGate } from '../src/approval/askGate.ts';
import { ApprovalGate } from '../src/approval/gate.ts';
import { readDecision } from '../src/artifacts/artifact.ts';
import type { LoadedConfig } from '../src/config/load.ts';
import type { ProjectConfig, ResolvedProfile, ResolvedRoute } from '../src/config/schema.ts';
import { Run } from '../src/run/Run.ts';

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function route(stage: StageId): ResolvedRoute {
  return {
    stage,
    provider: 'p',
    providerDef: { flow: 'loop', kind: 'openai-compat' },
    model: 'm',
    modelId: 'm',
    flow: 'loop',
    rank: 1,
    params: null,
    leanTools: false,
    formFill: false,
    claimFill: false,
    reviewFill: false,
    skipTurnAfterReviewFill: false,
    planAxisFill: false,
    stepFill: false,
    stepContext: false,
    compactForms: 'off',
    exploreIndex: false,
    exploreFill: false,
  };
}

function profile(): ResolvedProfile {
  const routes = Object.fromEntries(STAGE_ORDER.map((s) => [s, route(s)])) as Record<StageId, ResolvedRoute>;
  const ensemble = Object.fromEntries(STAGE_ORDER.map((s) => [s, [routes[s]]])) as Record<StageId, ResolvedRoute[]>;
  return { name: 'demo', label: 'demo', routes, ensemble };
}

/** `Run` с гейтом, который одобряет всё, что до него доходит: проверяется то, что ДО гейта. */
function makeRun(root: string): Run {
  const project: ProjectConfig = { name: 'demo', projectRoot: root, activeProfile: 'demo', maxBudgetUsd: 1, profiles: {} };
  const config = {
    runner: {
      port: 0,
      operator: 'Гриц',
      skillsDir: join(root, 'skills'),
      agentsDir: join(root, 'agents'),
      methodologyDir: join(root, 'methodology'),
      limits: {
        maxToolResultBytes: 1000,
        readRangeRequiredAboveBytes: 1000,
        maxIterationsPerStage: 4,
        gateTimeoutMs: 1000,
        progressClosenessWarn: 0.9,
        chatTimeoutMs: 1000,
      },
    },
    models: { models: [] },
    projects: new Map(),
    mcp: new Map(),
  } as unknown as LoadedConfig;
  const gate: ApprovalGate = new ApprovalGate({
    onPending: (p) => {
      gate.resolve(p.runId, p.requestId, { allowed: true, updatedInput: null, by: 'operator' });
    },
    onResolved: () => {},
  });
  return new Run({
    config,
    project,
    profile: profile(),
    slug: 'demo',
    gate,
    askGate: new AskGate({ onPending: () => {}, onAnswered: () => {} }),
    emit: () => {},
  });
}

type Salvage = { salvageFromText(text: string, produced: readonly string[], stage: StageId): Promise<string | null> };

const BLANK = [
  '# Журнал chunk’а 1: demo',
  '',
  '## Место правки',
  '',
  '- Точки правки по итогам точечной разведки: ‹файл:символ, …›',
  '- Карта разведки: совпала / разошлась — ‹что именно›',
  '',
  '- **Подтвердил:** ‹имя› · ‹дата›',
  '',
  '## Попытки',
  '',
  '| K | Дата | Что чинили | Что изменилось | Итог |',
  '|---|---|---|---|---|',
  '| 1 | ‹дата› | первая попытка | н/п | ещё не проверялась |',
  '',
].join('\n');

function seed(): { root: string; journal: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sdlc-salvage-dec-')));
  roots.push(root);
  const dir = join(root, '.sdlc', 'demo');
  mkdirSync(dir, { recursive: true });
  const journal = join(dir, 'chunk-1-journal.md');
  writeFileSync(journal, BLANK, 'utf8');
  return { root, journal };
}

describe('salvageFromText: поля решений человека', () => {
  it('журнал напечатан без строки «Подтвердил» — поле возвращается в записанный файл', async () => {
    const { root, journal } = seed();
    const run = makeRun(root) as unknown as Salvage;
    const printed = [
      '# Журнал chunk’а 1: demo',
      '',
      '## Место правки',
      '',
      '- Точки правки по итогам точечной разведки: src/store.ts:parse',
      '- Карта разведки: совпала',
      '',
      '## Попытки',
      '',
      '| K | Дата | Что чинили | Что изменилось | Итог |',
      '|---|---|---|---|---|',
      '| 1 | 2026-09-24 | первая попытка | н/п | ещё не проверялась |',
    ].join('\n');
    const text = ['Вот журнал:', '', '### Файл `chunk-1-journal.md`', '', '```', printed, '```', ''].join('\n');

    const note = await run.salvageFromText(text, [journal], 'chunk');
    ok(note !== null && note.includes('записал'), note ?? 'спасения не было');
    const saved = readFileSync(journal, 'utf8');
    ok(saved.includes('src/store.ts:parse'), saved);
    strictEqual(readDecision(saved, 'Подтвердил').state, 'placeholder', saved);
  });

  it('поле вернуть нельзя (структура документа сломана) — блок пропущен с нотой, файл не тронут', async () => {
    const { root, journal } = seed();
    const run = makeRun(root) as unknown as Salvage;
    const text = ['### Файл `chunk-1-journal.md`', '', '```', 'подтверждаю, всё сделано', '```', ''].join('\n');

    const note = await run.salvageFromText(text, [journal], 'chunk');
    ok(note !== null && note.includes('не спасено') && note.includes('Подтвердил'), note ?? 'ноты нет');
    strictEqual(readFileSync(journal, 'utf8'), BLANK);
  });
});
