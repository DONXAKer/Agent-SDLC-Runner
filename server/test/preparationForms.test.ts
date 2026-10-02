import { strictEqual, ok } from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { WitokPaths } from '../src/artifacts/paths.ts';
import { initializePreparation, preparation } from '../src/artifacts/preparation.ts';
import { writeArtifact } from '../src/artifacts/artifact.ts';
import { seedPreparationForms } from '../src/run/preparationForms.ts';

const roots: string[] = [];
after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

describe('compact preparation forms', () => {
  it('seeds machine-readable claim blocks for Runner rendering', () => {
    const root = mkdtempSync(join(tmpdir(), 'preparation-intent-form-'));
    roots.push(root);
    const paths = new WitokPaths(root, 'pilot');
    initializePreparation(paths, 'move a hold');
    writeArtifact(paths.intent, '<!-- sdlc-template: intent v1 -->\nold form');
    seedPreparationForms(paths, [{ path: paths.intent, template: 'fixture' }]);
    const text = readFileSync(paths.intent, 'utf8');
    ok(text.includes('sdlc-json:acceptance:start'));
    ok(text.includes('‹acceptance_json›'));
    ok(text.includes('sdlc-json:basis:start'));
    ok(text.includes('‹basis_json›'));
    strictEqual(preparation(paths)?.structuredTablesRequired, true);
  });

  it('seeds a concise exploration form with source-backed code map and checks', () => {
    const root = mkdtempSync(join(tmpdir(), 'preparation-form-'));
    roots.push(root);
    const paths = new WitokPaths(root, 'pilot');
    initializePreparation(paths, 'move a hold');
    writeArtifact(paths.explorationReport, '<!-- sdlc-template: exploration-report v1 -->\nold form');
    const seeded = [{ path: paths.explorationReport, template: 'fixture' }];
    seedPreparationForms(paths, seeded);
    const text = readFileSync(paths.explorationReport, 'utf8');
    ok(text.includes('## Карта кодовой базы'));
    ok(text.includes('| Файл / путь | Символ или тест |'));
    ok(text.includes('## Проверки'));
    ok(text.length < 2_000, 'v2 report form should stay compact');
  });

  it('seeds a compact plan form with explicit decision, scope, claims, and impact axes', () => {
    const root = mkdtempSync(join(tmpdir(), 'preparation-plan-form-'));
    roots.push(root);
    const paths = new WitokPaths(root, 'pilot');
    initializePreparation(paths, 'move a hold');
    writeArtifact(paths.plan, '<!-- sdlc-template: plan v1 -->\nold form');
    const seeded = [{ path: paths.plan, template: 'fixture' }];
    seedPreparationForms(paths, seeded);
    const text = readFileSync(paths.plan, 'utf8');
    for (const section of ['## Подход', '## files_to_touch', '## Проверки приёмки', '## Последствия шагов', 'claim-1', 'Наблюдаемость']) {
      ok(text.includes(section), `missing required plan content: ${section}`);
    }
    ok(text.length < 6_000, 'v2 plan form should stay concise');
  });
});
