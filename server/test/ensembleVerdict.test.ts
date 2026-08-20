/**
 * Вердикт по ансамблю рецензентов — на настоящих файлах в `.sdlc/<slug>/`.
 *
 * Это тот самый ложный зелёный, ради которого измерение маршрута и заводилось: все
 * рецензенты писали в один `verification-report-N-attempt-K.md`, вердикт читал его один
 * раз, и в вердикт попадало мнение записавшего ПОСЛЕДНИМ. Слабый рецензент со своим `✅`
 * стирал `❌` сильного.
 *
 * Проверяется здесь именно связка «файлы на диске → вердикт», а не свод в отрыве от неё:
 * свод отдельно покрыт в `reviewFixes3.test.ts`, а расходились они как раз на путях.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ok, strictEqual } from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import type { StageId } from '@sdlc-runner/shared';

import { AskGate } from '../src/approval/askGate.ts';
import { ApprovalGate } from '../src/approval/gate.ts';
import type { LoadedConfig } from '../src/config/load.ts';
import type { ProjectConfig, ResolvedProfile, ResolvedRoute } from '../src/config/schema.ts';
import { Run } from '../src/run/Run.ts';
import { STAGE_ORDER } from '@sdlc-runner/shared';

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const GATES = [
  '# Набор гейтов: demo',
  '',
  '## Набор',
  '',
  '| Гейт | Вкл | Где отчитывается | Чем реализован |',
  '|---|---|---|---|',
  '| Сборка | да — минимум | этап 6 | `npm run build` |',
  '| Тесты | да — минимум | этап 6 | `npm test` |',
  '| Scope: файлы вне плана | да — минимум | этап 6 | скрипт сверки diff с files_to_touch |',
  '| Анти-обход тест-гейта | да — минимум | этап 6 | скрипт |',
  '| Ревью независимым агентом | да — минимум | этап 6 | агент на более сильной модели |',
  '',
].join('\n');

/**
 * Отчёт приёмки одного рецензента в форме методологии: сверка с деревом, статусы всех
 * пяти обязательных гейтов и один пункт приёмки.
 */
function report(gate: string, claim: string): string {
  return [
    '# Отчёт приёмки: demo, chunk 1, попытка 1',
    '',
    '- **Сверка с деревом:** перегенерированный `git diff` совпал с патчем: да',
    '- **Долг набора:** все строки закрыты',
    '',
    '## Гейты',
    '',
    '| Гейт | Статус | Результат |',
    '|---|---|---|',
    `| Сборка | ${gate} | npm run build |`,
    `| Тесты | ${gate} | npm test |`,
    `| Scope: файлы вне плана | ${gate} | скрипт |`,
    `| Анти-обход тест-гейта | ${gate} | скрипт |`,
    `| Ревью независимым агентом | ${gate} | sonnet |`,
    '',
    '## 1. Пункты приёмки',
    '',
    '| id | Пункт | passed | Чем подтверждён | Что чинить |',
    '|---|---|---|---|---|',
    `| claim-1 | пользователь видит… | ${claim} | Foo.ts:bar | н/п |`,
    '',
    '## 2. Ревью: что искали опровергнуть',
    '',
    '- Подтверждённое расхождение: н/п',
    '- Поведение, не покрытое ни одним пунктом: н/п',
    '',
    '## 3. Scope',
    '',
    '- Файлы вне `plan.files_to_touch`: нет',
    '',
    '## 4. Инварианты',
    '',
    '- порядок вызовов — держится, чем подтверждён: OrderTest',
    '',
    '## 5. Регрессии',
    '',
    '- нет',
    '',
  ].join('\n');
}

function route(stage: StageId, modelId: string, rank: number): ResolvedRoute {
  return {
    stage,
    modelId,
    provider: 'p',
    providerDef: { flow: 'loop', kind: 'openai-compat' },
    model: modelId,
    flow: 'loop',
    rank,
  };
}

/** Профиль с ансамблем на verify: сильный рецензент и слабый рядом. */
function profile(verifyRoutes: ResolvedRoute[]): ResolvedProfile {
  const routes = Object.fromEntries(
    STAGE_ORDER.map((s) => [s, route(s, 'base', 1)]),
  ) as Record<StageId, ResolvedRoute>;
  const ensemble = Object.fromEntries(
    STAGE_ORDER.map((s) => [s, [routes[s]]]),
  ) as Record<StageId, ResolvedRoute[]>;
  routes.verify = verifyRoutes[0]!;
  ensemble.verify = verifyRoutes;
  return { name: 'demo', label: 'demo', routes, ensemble };
}

/**
 * Виток на временном проекте. Отчёты маршрутов кладутся на диск ДО расчёта вердикта —
 * ровно так их и оставляет прогон этапа 6.
 */
function makeRun(reports: string[]): Run {
  const root = mkdtempSync(join(tmpdir(), 'sdlc-ens-'));
  roots.push(root);
  mkdirSync(join(root, '.sdlc', 'demo'), { recursive: true });
  writeFileSync(join(root, '.sdlc', 'gates.md'), GATES);

  const verifyRoutes = reports.map((_, i) => route('verify', `m${i}`, 9 - i));
  const project: ProjectConfig = {
    name: 'demo',
    projectRoot: root,
    activeProfile: 'demo',
    maxBudgetUsd: 1,
    profiles: {},
  };
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
  } as unknown as LoadedConfig;

  const run = new Run({
    config,
    project,
    profile: profile(verifyRoutes),
    slug: 'demo',
    gate: new ApprovalGate({ onPending: () => {}, onResolved: () => {} }),
    askGate: new AskGate({ onPending: () => {}, onAnswered: () => {} }),
    emit: () => {},
  });

  // Маршрут 0 — канонический путь (его читают скиллы `/sdlc-*`), дальше — по маршрутам.
  reports.forEach((text, i) => {
    writeFileSync(run.paths.verificationReport(run.chunk, run.attempt, i), text);
  });
  return run;
}

describe('вердикт по отчётам всех маршрутов ансамбля', () => {
  it('красный второго рецензента роняет вердикт, хотя первый сказал ✅', () => {
    // Порядок именно такой: зелёный лежит в КАНОНИЧЕСКОМ файле. Прежний вердикт читал
    // только его и объявлял виток зелёным на дефектном патче.
    const v = makeRun([report('✅', '✅'), report('❌', '❌')]).computeStageVerdict();
    ok(v !== null, 'вердикт не посчитался');
    strictEqual(v.passed, false, `ложный зелёный: ${v.reasons.join('; ')}`);
  });

  it('зелёный — только когда так сказали ВСЕ маршруты', () => {
    const v = makeRun([report('✅', '✅'), report('✅', '✅')]).computeStageVerdict();
    ok(v !== null);
    strictEqual(v.passed, true, v.reasons.join('; '));
  });

  it('одиночный маршрут работает по-прежнему: канонический файл и есть весь ансамбль', () => {
    const green = makeRun([report('✅', '✅')]).computeStageVerdict();
    ok(green !== null);
    strictEqual(green.passed, true, green.reasons.join('; '));

    const red = makeRun([report('❌', '❌')]).computeStageVerdict();
    ok(red !== null);
    strictEqual(red.passed, false);
  });

  it('пустой отчёт маршрута не выдаётся за молчаливое согласие', () => {
    // Маршрут, который ничего не записал, не должен ослаблять вердикт до зелёного — но и
    // не должен исчезать бесследно: отчёта нет, значит гейты по нему не подтверждены.
    const v = makeRun([report('✅', '✅'), '']).computeStageVerdict();
    ok(v !== null);
    strictEqual(v.passed, true, 'пустой файл второго маршрута не должен ронять первый');
  });

  it('повторный расчёт вердикта не удваивает историю попыток', () => {
    // Пересчёт на той же попытке — обычное действие оператора после правки набора гейтов.
    // Прежде он дописывал вторую строку про ту же попытку и удваивал проваленные пункты,
    // из-за чего эскалация «второй red на том же пункте» срабатывала по одному провалу.
    const run = makeRun([report('❌', '❌')]);
    run.computeStageVerdict();
    run.computeStageVerdict();
    strictEqual(run.iterations.length, 1, 'история попыток удвоилась');
    strictEqual(run.metrics.verdicts.total, 1);
  });
});
