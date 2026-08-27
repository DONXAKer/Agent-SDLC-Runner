import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { writeArtifact } from '../src/artifacts/artifact.ts';
import { WitokPaths } from '../src/artifacts/paths.ts';
import { scanHistory } from '../src/history.ts';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'sdlc-history-test-')));
after(() => rmSync(root, { recursive: true, force: true }));

const NO_LIVE = new Set<string>();

describe('scanHistory', () => {
  it('пустой/несуществующий .sdlc — пустой список, не падает', () => {
    const empty = join(root, 'no-sdlc-here');
    deepStrictEqual(scanHistory(empty, NO_LIVE), []);
  });

  it('handoff.md с granted «Приёмка» — статус done, lastStage handoff', () => {
    const paths = new WitokPaths(root, 'done-witok');
    writeArtifact(paths.intent, '# Цель\n');
    writeArtifact(paths.handoff, '- **Приёмка:** Иван · 2026-08-16\n');

    const entries = scanHistory(root, NO_LIVE);
    const e = entries.find((x) => x.slug === 'done-witok');
    strictEqual(e?.status, 'done');
    strictEqual(e.lastStage, 'handoff');
  });

  it('handoff.md с отклонённой «Приёмкой» (обрыв) — статус aborted', () => {
    const paths = new WitokPaths(root, 'aborted-witok');
    writeArtifact(paths.intent, '# Цель\n');
    writeArtifact(paths.handoff, '- **Приёмка:** не принималась — обрыв: кончился бюджет\n');

    const entries = scanHistory(root, NO_LIVE);
    const e = entries.find((x) => x.slug === 'aborted-witok');
    strictEqual(e?.status, 'aborted');
  });

  it('нет handoff.md, слаг держит сервер в памяти — статус open', () => {
    const paths = new WitokPaths(root, 'open-witok');
    writeArtifact(paths.intent, '# Цель\n');
    writeArtifact(paths.plan, '# План\n');

    const entries = scanHistory(root, new Set(['open-witok']));
    const e = entries.find((x) => x.slug === 'open-witok');
    strictEqual(e?.status, 'open');
    strictEqual(e.lastStage, 'plan');
  });

  it('нет handoff.md, сервер витка не помнит — статус unfinished', () => {
    const paths = new WitokPaths(root, 'left-witok');
    writeArtifact(paths.intent, '# Цель\n');

    const entries = scanHistory(root, NO_LIVE);
    const e = entries.find((x) => x.slug === 'left-witok');
    strictEqual(e?.status, 'unfinished');
    strictEqual(e.lastStage, 'intent');
  });

  it('lastStage — самый дальний артефакт, а не intent, если виток продвинулся дальше', () => {
    const paths = new WitokPaths(root, 'far-witok');
    writeArtifact(paths.intent, '# Цель\n');
    writeArtifact(paths.plan, '# План\n');
    writeArtifact(paths.chunkJournal(1), '# Журнал chunk 1\n');
    writeArtifact(paths.verificationReport(1, 1), 'passed: false\n');

    const entries = scanHistory(root, NO_LIVE);
    const e = entries.find((x) => x.slug === 'far-witok');
    strictEqual(e?.lastStage, 'verify');
  });
});
