/** Сверка адресов одобренного плана с текущим деревом до начала chunk. */

import { ok, strictEqual } from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { mkdirSync, mkdtempSync, realpathSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WitokPaths } from '../src/artifacts/paths.ts';
import { resolvedRequirementsHash } from '../src/artifacts/resolvedRequirements.ts';
import { callersBlock, planMapProblem, planRequirementsProblem } from '../src/run/stages/plan.ts';
import type { StageContext } from '../src/run/stages.ts';

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function setup(fileText: string, step: string): StageContext {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sdlc-plan-map-')));
  roots.push(root);
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, '.sdlc', 'demo'), { recursive: true });
  writeFileSync(join(root, 'src', 'tariffs.ts'), fileText);
  const paths = new WitokPaths(root, 'demo');
  writeFileSync(paths.intent, '# Intent\nClaim 1');
  const hash = resolvedRequirementsHash('# Intent\nClaim 1', '');
  writeFileSync(paths.plan, [
    '# Plan',
    `- **Требования (SHA-256):** \`${hash}\``,
    '## Шаги',
    step,
    '## files_to_touch',
    '| Путь | Что делаем |',
    '|---|---|',
    '| `src/tariffs.ts` | update |',
  ].join('\n'));
  return { paths, chunk: 1, attempt: 1 };
}

const STEP = [
  '### Шаг 1 — поправить priceFor',
  '- файл: `src/tariffs.ts`',
  '- символ: priceFor',
  '- действие: применить надбавку',
  '- закрывает: claim-1',
  '- проверка: `npm test`',
  '- контракт: н/п — сигнатура не меняется',
  '- зависит от: нет',
].join('\n');

describe('planMapProblem', () => {
  it('принимает существующий файл и символ', () => {
    strictEqual(planMapProblem(setup('export function priceFor() {}', STEP)), null);
  });

  it('возвращает план на исправление, если символ исчез', () => {
    const problem = planMapProblem(setup('export function basePrice() {}', STEP));
    ok(problem?.includes('priceFor'));
    ok(problem?.includes('этап 4'));
  });

  it('принимает явно новый символ, если имя требуется задачей', () => {
    const ctx = setup('', STEP.replace('- символ: priceFor', '- символ: новый: moveHold'));
    const intentText = '# Intent\nClaim 1 requires moveHold';
    writeFileSync(ctx.paths.intent, intentText);
    const hash = resolvedRequirementsHash(intentText, '');
    const planText = readFileSync(ctx.paths.plan, 'utf8').replace(/^- \*\*Требования \(SHA-256\):\*\*.*$/m, `- **Требования (SHA-256):** \`${hash}\``);
    writeFileSync(ctx.paths.plan, planText);
    strictEqual(planMapProblem(ctx), null);
  });

  it('не принимает новый символ, которого нет в требованиях', () => {
    const ctx = setup('', STEP.replace('- символ: priceFor', '- символ: новый: moveHold'));
    const hash = resolvedRequirementsHash('# Intent\nClaim 1', '');
    const planText = readFileSync(ctx.paths.plan, 'utf8').replace(/^- \*\*Требования \(SHA-256\):\*\*.*$/m, `- **Требования (SHA-256):** \`${hash}\``);
    writeFileSync(ctx.paths.plan, planText);
    ok(planMapProblem(ctx)?.includes('не подтверждён как новый требуемый символ'));
  });

  it('останавливает передачу, если задача изменилась после фиксации плана', () => {
    const ctx = setup('export function priceFor() {}', STEP);
    writeFileSync(ctx.paths.intent, '# Intent\nClaim 1 changed');
    const problem = planRequirementsProblem(ctx);
    ok(problem?.includes('SHA-256'));
    ok(problem?.includes('этап 4'));
  });

  it('требует адресное решение по каждому найденному вызывающему изменённого контракта', () => {
    const ctx = setup(
      'export function priceFor(input: number) { return input; }',
      STEP.replace('- контракт: н/п — сигнатура не меняется', '- контракт: `priceFor(number)` → `priceFor(number, zone)`'),
    );
    const consumerPath = join(ctx.paths.projectRoot, 'src', 'consumer.ts');
    writeFileSync(consumerPath, "import { priceFor } from './tariffs.js';\nexport const total = priceFor(1);\n");

    let planText = readFileSync(ctx.paths.plan, 'utf8');
    planText += [
      '',
      '## Затронутые вызовы/сигнатуры',
      '',
      '| Символ (`путь:имя`) | Что меняется в контракте | Вызывающие (`путь:строка`) | Учтены в files_to_touch? |',
      '|---|---|---|---|',
      '| `src/tariffs.ts:priceFor` | второй параметр | `src/consumer.ts:2` | нет — совместим без правок: новый параметр имеет значение по умолчанию |',
    ].join('\n');
    writeFileSync(ctx.paths.plan, planText);
    strictEqual(planMapProblem(ctx), null);

    const unsupportedYes = planText.replace('нет — совместим без правок: новый параметр имеет значение по умолчанию', 'да');
    writeFileSync(ctx.paths.plan, unsupportedYes);
    ok(planMapProblem(ctx)?.includes('src/consumer.ts:2'));

    const callerInScope = unsupportedYes.replace(
      '| `src/tariffs.ts` | update |',
      '| `src/tariffs.ts` | update |\n| `src/consumer.ts` | update call |',
    );
    writeFileSync(ctx.paths.plan, callerInScope);
    strictEqual(planMapProblem(ctx), null);

    writeFileSync(ctx.paths.plan, callerInScope.replace('`src/consumer.ts:2`', '`src/consumer.ts:1`'));
    ok(planMapProblem(ctx)?.includes('src/consumer.ts:2'));
  });

  it('передаёт планировщику вызывающих сверх прежнего лимита пяти файлов', () => {
    const ctx = setup('export function priceFor(input: number) { return input; }', STEP);
    for (let n = 0; n < 7; n++) {
      writeFileSync(join(ctx.paths.projectRoot, 'src', `consumer-${n}.ts`), `export const value${n} = priceFor(${n});\n`);
    }
    const block = callersBlock(ctx);
    ok(block?.includes('src/consumer-6.ts:1'), block ?? 'нет карты вызывающих');
    ok(block?.includes('все найденные места'));
  });

  it('не блокирует старый план без явных карточек', () => {
    strictEqual(planMapProblem(setup('export function basePrice() {}', '1. legacy step')), null);
  });
});
