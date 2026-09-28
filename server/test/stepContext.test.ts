import { match, ok, strictEqual } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import type { PlanStep } from '../src/artifacts/planSteps.ts';
import { buildStepContext, STEP_CONTEXT_BYTES } from '../src/exec/stepContext.ts';

const roots: string[] = [];
after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'sdlc-context-'));
  roots.push(value);
  mkdirSync(join(value, 'src'), { recursive: true });
  mkdirSync(join(value, 'test'), { recursive: true });
  return value;
}

function step(overrides: Partial<PlanStep>): PlanStep {
  return {
    n: 1,
    title: 'Рассчитать НДС',
    file: 'src/vat.ts',
    isNew: true,
    symbol: 'calculateVat',
    action: 'Добавить расчёт НДС для денежных строк',
    claims: [],
    check: null,
    checkSpecified: false,
    expect: null,
    contractChange: null,
    contractSpecified: false,
    dependsOn: [],
    dependenciesSpecified: false,
    facts: null,
    explicit: true,
    ...overrides,
  };
}

describe('контекст шага', () => {
  it('подбирает связанные объявления и определяет стиль импортов', async () => {
    const project = root();
    writeFileSync(join(project, 'src/money.ts'), "export type Money = { cents: number };\nexport function roundMoney(value: number): Money {\n  return { cents: Math.round(value) };\n}\n");
    writeFileSync(join(project, 'src/lines.ts'), "import type { Money } from './money.ts';\nexport interface Line { net: Money; vatRate: number }\n");

    const context = await buildStepContext(project, step({}));

    match(context, /Контекст проекта/);
    match(context, /src\/money\.ts|src\/lines\.ts/);
    match(context, /Money|Line/);
    match(context, /Доступные API проекта/);
    match(context, /roundMoney/);
    match(context, /расширение `\.ts`/);
  });

  it('для тестового шага добавляет один близкий тест и не читает служебные каталоги', async () => {
    const project = root();
    writeFileSync(join(project, 'src/vat.ts'), 'export const calculateVat = (n: number) => n;\n');
    writeFileSync(join(project, 'test/money.test.ts'), "import test from 'node:test';\nimport { strictEqual } from 'node:assert';\ntest('money', () => strictEqual(1, 1));\n");
    mkdirSync(join(project, '.sdlc'), { recursive: true });
    writeFileSync(join(project, '.sdlc/hidden.test.ts'), 'DO_NOT_LEAK\n');

    const context = await buildStepContext(project, step({ file: 'test/vat.test.ts', title: 'Тест НДС' }));

    match(context, /Пример существующего теста: `test\/money\.test\.ts`/);
    match(context, /node:test/);
    strictEqual(context.includes('DO_NOT_LEAK'), false);
  });

  it('соблюдает общий лимит контекста', async () => {
    const project = root();
    for (let i = 0; i < 8; i++) writeFileSync(join(project, `src/vat-${i}.ts`), `export const vat${i} = '${'x'.repeat(4_000)}';\n`);
    const context = await buildStepContext(project, step({}));
    ok(Buffer.byteLength(context, 'utf8') <= STEP_CONTEXT_BYTES);
  });

  it('не читает исходник по символической ссылке за пределами проекта', async () => {
    const project = root();
    const outside = mkdtempSync(join(tmpdir(), 'sdlc-context-outside-'));
    roots.push(outside);
    writeFileSync(join(outside, 'vat.ts'), 'export const DO_NOT_LEAK = true;\n');
    try {
      symlinkSync(join(outside, 'vat.ts'), join(project, 'src/vat-secret.ts'));
    } catch {
      return;
    }

    const context = await buildStepContext(project, step({}));
    strictEqual(context.includes('DO_NOT_LEAK'), false);
  });
});
