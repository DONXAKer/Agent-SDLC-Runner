/**
 * `run/metricsSnapshot.ts` — один читатель снапшота чисел витка на `Run.restoreMetrics` и
 * на дашборд. Разбор снисходительный: старый или битый снапшот не ломает ни старт витка,
 * ни список запусков.
 */

import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { writeArtifact } from '../src/artifacts/artifact.ts';
import { WitokPaths } from '../src/artifacts/paths.ts';
import { normalizeMetrics, readMetricsRaw, readMetricsSnapshot } from '../src/run/metricsSnapshot.ts';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'sdlc-metrics-snap-test-')));
after(() => rmSync(root, { recursive: true, force: true }));

describe('normalizeMetrics', () => {
  it('старый снапшот без поздних полей — пустые массивы, а не падение', () => {
    const m = normalizeMetrics({ stages: [{ stage: 'intent', runs: 2, usage: { inputTokens: 5 }, durationMs: 10 }], verdicts: { total: 1, red: 1 } });
    strictEqual(m.stages[0]?.usage.inputTokens, 5);
    strictEqual(m.stages[0]?.usage.outputTokens, 0);
    deepStrictEqual(m.gates, []);
    deepStrictEqual(m.human, []);
    deepStrictEqual(m.artifactGaps, []);
    deepStrictEqual(m.chunkEvidence, []);
    deepStrictEqual(m.verdicts, { total: 1, red: 1 });
  });

  it('чужое и битое отбрасывается построчно', () => {
    const m = normalizeMetrics({
      stages: [null, { runs: 1 }, { stage: 'plan', runs: 'x' }],
      chunkEvidence: [{ chunk: 1, attempt: 2, testsStatus: '???', treeChanged: 'да' }],
    });
    deepStrictEqual(
      m.stages.map((s) => [s.stage, s.runs]),
      [['plan', 0]],
    );
    deepStrictEqual(m.chunkEvidence, [{ chunk: 1, attempt: 2, testsStatus: '⏭', treeChanged: false, scopeViolation: false }]);
    deepStrictEqual(normalizeMetrics('мусор').stages, []);
  });
});

describe('readMetricsSnapshot', () => {
  it('нет файла — null; битый JSON — null', () => {
    const p = new WitokPaths(root, 'none');
    strictEqual(readMetricsSnapshot(p), null);
    writeArtifact(p.metrics, '{ не json');
    strictEqual(readMetricsSnapshot(p), null);
  });

  it('прежнее место в корне витка читается; .runner/ побеждает', () => {
    const p = new WitokPaths(root, 'legacy');
    writeArtifact(p.metricsLegacy, JSON.stringify({ verdicts: { total: 3, red: 0 } }));
    strictEqual(readMetricsSnapshot(p)?.verdicts.total, 3);
    writeArtifact(p.metrics, JSON.stringify({ verdicts: { total: 7, red: 1 }, spent: { RUB: 12 } }));
    strictEqual(readMetricsSnapshot(p)?.verdicts.total, 7);
    deepStrictEqual(readMetricsRaw(p)?.spent, { RUB: 12 });
  });
});
