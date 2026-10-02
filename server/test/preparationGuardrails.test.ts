import { strictEqual, ok } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { after, describe, it } from 'node:test';

import { WitokPaths } from '../src/artifacts/paths.ts';
import {
  initializePreparation,
  preparationExploreEvidenceProblem,
  preparationPlanEvidenceProblem,
  recordPreparationRead,
} from '../src/artifacts/preparation.ts';
import { planStepsProblem } from '../src/run/stages/plan.ts';
import { writeArtifact } from '../src/artifacts/artifact.ts';

const roots: string[] = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

function fixture(request: string): { root: string; paths: WitokPaths } {
  const root = mkdtempSync(join(tmpdir(), 'sdlc-guardrails-'));
  roots.push(root);
  const paths = new WitokPaths(root, 'pilot');
  initializePreparation(paths, request);
  return { root, paths };
}

function source(root: string, path: string, text = 'export const example = 1;'): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, text, 'utf8');
}

describe('preparation source evidence guard', () => {
  it('requires successful source-card evidence for existing paths named by the requester', () => {
    const { root, paths } = fixture('Сверь src/hold.ts и test/hold.test.ts; не меняй src/slots.ts.');
    for (const file of ['src/hold.ts', 'test/hold.test.ts', 'src/slots.ts']) source(root, file);
    strictEqual(preparationExploreEvidenceProblem(paths), 'до завершения разведки Runner должен передать модели карточки указанных исходников и тестов: src/hold.ts, test/hold.test.ts, src/slots.ts');
    for (const file of ['src/hold.ts', 'test/hold.test.ts', 'src/slots.ts']) {
      recordPreparationRead(paths, 'explore', file, 'успешно прочитанное содержимое');
    }
    strictEqual(preparationExploreEvidenceProblem(paths), null);
  });

  it('accepts plan citations only when they match current successful Read evidence', () => {
    const { root, paths } = fixture('Основание: src/hold.ts и test/hold.test.ts.');
    source(root, 'src/hold.ts');
    source(root, 'test/hold.test.ts');
    const plan = '## Подход\nНовый объект на основании src/hold.ts:Hold и test/hold.test.ts.';
    strictEqual(preparationPlanEvidenceProblem(paths, plan), 'решение в «Подход» ссылается на непереданные или изменившиеся исходники: src/hold.ts, test/hold.test.ts — используй источники из отчёта разведки и обнови обоснование');
    recordPreparationRead(paths, 'explore', 'src/hold.ts', 'source');
    recordPreparationRead(paths, 'explore', 'test/hold.test.ts', 'test');
    strictEqual(preparationPlanEvidenceProblem(paths, plan), null);
    source(root, 'test/hold.test.ts', 'changed');
    ok(preparationPlanEvidenceProblem(paths, plan)?.includes('test/hold.test.ts'));
  });
});

describe('preparation claim coverage', () => {
  it('requires each accepted claim to be addressed by a plan step', () => {
    const { paths } = fixture('Пилот');
    writeArtifact(paths.intent, [
      '## Приёмочный лист',
      '| ID | Пункт | Проверка |',
      '|---|---|---|',
      '| claim-1 | Первый пункт | тест 1 |',
      '| claim-2 | Второй пункт | тест 2 |',
    ].join('\n'));
    writeArtifact(paths.plan, [
      '### Шаг 1 — Реализовать',
      '- файл: src/a.ts',
      '- действие: реализовать поведение',
      '- закрывает: claim-1',
      '- проверка: тест',
      '- контракт: н/п — контракт не меняется',
      '- зависит от: нет',
    ].join('\n'));
    ok(planStepsProblem({ paths, chunk: 1, attempt: 1 })?.includes('claim-2'));
    writeArtifact(paths.plan, [
      '### Шаг 1 — Реализовать',
      '- файл: src/a.ts',
      '- действие: реализовать поведение',
      '- закрывает: claim-1 и claim-2',
      '- проверка: тест',
      '- контракт: н/п — контракт не меняется',
      '- зависит от: нет',
    ].join('\n'));
    strictEqual(planStepsProblem({ paths, chunk: 1, attempt: 1 }), null);
  });
});
