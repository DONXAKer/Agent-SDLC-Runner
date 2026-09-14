/**
 * Этап-виновник блокировки: чей артефакт завалил предусловие.
 *
 * Серия v4: 8 из 25 прогонов показывали «explore red, 0 вызовов» при «intent ok» —
 * этап не стартовал, а по отчёту это читалось его провалом.
 */

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { WitokPaths } from '../src/artifacts/paths.ts';
import { checkPreconditions, stageById, stageProducing } from '../src/run/stages.ts';

describe('stageProducing', () => {
  const root = join(tmpdir(), 'sdlc-stage-producing');
  const c = { paths: new WitokPaths(root, 'demo'), chunk: 1, attempt: 2 };

  it('readiness производят двое: вход в explore винит intent, вход в chunk — plan', () => {
    strictEqual(stageProducing(c.paths.readiness, 'explore', c), 'intent');
    strictEqual(stageProducing(c.paths.readiness, 'chunk', c), 'plan');
  });

  it('патч попытки — chunk, хоть его и пишет рантайм; отчёт приёмки — verify', () => {
    strictEqual(stageProducing(c.paths.chunkDiff(1, 2), 'verify', c), 'chunk');
    strictEqual(stageProducing(c.paths.verificationReport(1, 2), 'handoff', c), 'verify');
  });

  it('артефакт СВОЕГО или более позднего этапа виновником не бывает; чужой путь — null', () => {
    strictEqual(stageProducing(c.paths.plan, 'plan', c), null);
    strictEqual(stageProducing(join(root, 'src', 'a.ts'), 'chunk', c), null);
  });

  it('разделители пути не влияют: Windows-путь находит тот же этап', () => {
    strictEqual(stageProducing(c.paths.intent.replace(/\//g, '\\'), 'explore', c), 'intent');
  });
});

describe('виновник у решения человека', () => {
  function chunkDetails(planText: string) {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-granted-'));
    const c = { paths: new WitokPaths(root, 'demo'), chunk: 1, attempt: 1 };
    mkdirSync(join(root, '.sdlc', 'demo'), { recursive: true });
    writeFileSync(c.paths.plan, planText);
    try {
      return { details: checkPreconditions(stageById('chunk'), c).details, plan: c.paths.plan };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it('поле «Одобрение» есть, но пусто — вина не этапа plan, виновника нет', () => {
    const { details } = chunkDetails('# План: demo\n\n- **Одобрение:** ‹имя› · ‹дата›\n');
    strictEqual(details.length, 1);
    strictEqual(details[0]!.artifact, null);
  });

  it('поля «Одобрение» в форме нет — форму сломал этап plan, он и виновник', () => {
    const { details, plan } = chunkDetails('# План: demo\n\n## Подход\n\nтекст\n');
    strictEqual(details.length, 1);
    strictEqual(details[0]!.artifact, plan);
  });
});

describe('checkPreconditions.details', () => {
  it('каждая причина несёт свой артефакт, и все ведут к виновнику intent на входе в explore', () => {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-preconditions-'));
    try {
      const c = { paths: new WitokPaths(root, 'demo'), chunk: 1, attempt: 1 };
      const report = checkPreconditions(stageById('explore'), c);
      ok(report.problems.length > 0);
      deepStrictEqual(
        report.details.map((d) => d.text),
        report.problems,
      );
      deepStrictEqual(
        [...new Set(report.details.map((d) => (d.artifact === null ? null : stageProducing(d.artifact, 'explore', c))))],
        ['intent'],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
