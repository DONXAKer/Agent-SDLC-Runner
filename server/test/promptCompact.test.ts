/**
 * `compactForms` в сборке промпта: без ручки поведение не меняется ни на байт; с
 * `'inputs'`/`'all'` входные артефакты loop-этапов-документов и план на входе chunk идут
 * сжатой проекцией; verify получает полный текст всегда. С `'fill'`/`'all'` few-shot
 * показывает `FillField` вместо `Edit`.
 *
 * Герметичный тест: тексты этапов и артефакты — во временном каталоге, эталона
 * методологии не требует (по образцу `promptEcosystem.test.ts`).
 */

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { WitokPaths } from '../src/artifacts/paths.ts';
import type { RunnerConfig } from '../src/config/schema.ts';
import { buildPrompt, type BuildPromptInput } from '../src/prompt/build.ts';
import { stageById } from '../src/run/stages.ts';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'sdlc-compact-prompt-')));
after(() => rmSync(root, { recursive: true, force: true }));

const skillsDir = join(root, 'skills');
for (const skill of ['sdlc-intent', 'sdlc-plan', 'sdlc-chunk', 'sdlc-verify']) {
  mkdirSync(join(skillsDir, skill), { recursive: true });
  writeFileSync(join(skillsDir, skill, 'SKILL.md'), `# ${skill}\nтело этапа\n`);
}

const runner: RunnerConfig = {
  port: 8030,
  operator: 'Гриц',
  skillsDir,
  agentsDir: join(root, 'agents'),
  methodologyDir: join(root, 'methodology'),
  limits: {
    maxToolResultBytes: 1000,
    readRangeRequiredAboveBytes: 1000,
    maxIterationsPerStage: 10,
    gateTimeoutMs: 1000,
    progressClosenessWarn: 0.9,
    chatTimeoutMs: 1000,
    localMaxToolResultBytes: 12_000,
    localHistoryBudgetBytes: 40_000,
  },
};

const paths = new WitokPaths(root, 'demo');

// Артефакт с легендой, цитатой-шапкой и меню — ровно то, что проекция обязана сжать.
const INTENT_TEXT = [
  '# Задача: demo',
  '',
  '> Этап 1. Заполняет **человек**. Незаполненные места помечены `‹…›`.',
  '',
  '- **Контур:** полный / мелкий — критерий в SDLC.md',
  '',
  '## Коротко',
  '_Одно-два предложения: что делаем._',
  '',
  'Сделать штуку.',
  '',
  '## Приёмочный лист',
  '',
  '| id | Пункт | Как проверить |',
  '|---|---|---|',
  '| claim-1 | код 200 | тест retryReturns200 |',
  '',
].join('\n');

const PLAN_TEXT = [
  '# План: demo',
  '',
  '> Этап 4. Заполняет агент, **одобряет человек**.',
  '',
  '- **Одобрение:** Иван · 2026-09-02',
  '',
  '## Подход',
  '_Одно-два предложения: как решаем._',
  '',
  'Переиспользуем guard.',
  '',
  '## Полнота листа',
  '',
  '- **Статус:** ✅ / ❌ — не покрыто',
  '',
].join('\n');

mkdirSync(paths.dir, { recursive: true });
writeFileSync(paths.intent, INTENT_TEXT, 'utf8');
writeFileSync(paths.readiness, '# Готовность\nготова\n', 'utf8');
writeFileSync(paths.plan, PLAN_TEXT, 'utf8');

function build(stage: 'intent' | 'plan' | 'chunk' | 'verify', compactForms?: BuildPromptInput['compactForms']) {
  return buildPrompt({
    runner,
    stage: stageById(stage),
    ctx: { paths, chunk: 1, attempt: 1 },
    flow: 'loop',
    slug: 'demo',
    ...(compactForms === undefined ? {} : { compactForms }),
    now: new Date('2026-09-02T00:00:00Z'),
  });
}

describe('compactForms не задан — промпт байт-в-байт прежний', () => {
  it('plan: с undefined и с "off" один и тот же текст', () => {
    const withoutFlag = build('plan');
    const withOff = build('plan', 'off');
    deepStrictEqual(withoutFlag.user, withOff.user);
    deepStrictEqual(withoutFlag.system, withOff.system);
  });

  it('plan: intent.md на входе идёт полным текстом, без пометки проекции', () => {
    // `plan` — реальный вход `intent.md` (`stageInputs('plan', …)`); сам intent.md на
    // СВОЁМ этапе входом не является (его только производят), поэтому проекция
    // проверяется там, где артефакт действительно читается.
    const p = build('plan');
    ok(p.user.includes('Незаполненные места помечены'), 'цитата-шапка осталась целиком');
    ok(p.user.includes('_Одно-два предложения: что делаем._'), 'курсивная легенда не срезана');
    ok(!p.user.includes('сжатая проекция'));
  });
});

describe('compactForms "inputs": проекция на capped-этапах и на плане во входе chunk', () => {
  it('plan: легенда и цитата-шапка intent.md убраны, значения остаются', () => {
    const p = build('plan', 'inputs');
    ok(!p.user.includes('Незаполненные места помечены'), 'цитата-шапка обязана уйти');
    ok(!p.user.includes('_Одно-два предложения: что делаем._'), 'легенда обязана уйти');
    ok(p.user.includes('Сделать штуку.'), 'содержимое остаётся');
    ok(p.user.includes('claim-1'), 'значения таблицы остаются');
    ok(p.user.includes('сжатая проекция'), 'источник помечен явно');
  });

  it('plan на входе chunk идёт проекцией, chunk-журнал (его нет) не мешает', () => {
    const p = build('chunk', 'inputs');
    ok(!p.user.includes('Заполняет агент, **одобряет человек**'), 'цитата плана срезана в проекции');
    ok(p.user.includes('Переиспользуем guard.'));
  });

  it('verify получает полный текст входов независимо от ручки', () => {
    writeFileSync(paths.chunkDiff(1, 1), 'diff --git a b\n', 'utf8');
    writeFileSync(paths.gates, '# Набор гейтов\n', 'utf8');
    const withFlag = build('verify', 'inputs');
    const without = build('verify');
    deepStrictEqual(withFlag.user, without.user);
    ok(!withFlag.user.includes('сжатая проекция'));
  });

  it('"fill" сам по себе НЕ включает проекцию входов', () => {
    const p = build('plan', 'fill');
    ok(!p.user.includes('сжатая проекция'));
  });
});

// Проверяется JSON-МАРКЕР few-shot'а, а не голая подстрока «FillField»: право на
// инструмент (строка «Доступные инструменты: …») присутствует в системном промпте
// НЕЗАВИСИМО от режима в этом тесте (он собирается напрямую, минуя фильтр
// `Run.toolsFor` — тот в реальном прогоне и снимает право без `compactForms: fill|all`);
// few-shot же — единственное, что решает именно эта ручка.
const usesFillFieldExample = (system: string): boolean =>
  system.includes('"tool":"FillField"') || system.includes('"tool": "FillField"');

describe('compactForms "fill": few-shot показывает FillField, не Edit', () => {
  it('intent: пример вызова — FillField с полем схемы, не Edit с old_string', () => {
    const p = build('intent', 'fill');
    ok(usesFillFieldExample(p.system));
    ok(!p.system.includes('"tool":"Edit"') && !p.system.includes('"tool": "Edit"'));
  });

  it('"inputs" сам по себе НЕ переключает few-shot на FillField', () => {
    const p = build('intent', 'inputs');
    ok(!usesFillFieldExample(p.system));
  });

  it('"all": оба эффекта разом на одном этапе (plan — читает intent.md, производит plan.md)', () => {
    const p = build('plan', 'all');
    ok(usesFillFieldExample(p.system), 'few-shot: FillField на незаполненном поле plan.md');
    ok(p.user.includes('сжатая проекция'), 'вход intent.md — проекцией');
  });
});
