/**
 * Архив прежней редакции плана: имена `plan-vK.md` — артефакт витка, номер — следующий
 * свободный. Само переименование живёт в `planModule.begin().beforeSeed` и покрыто
 * сценарием эталона; здесь — раскладка и классификация имён.
 */

import { ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { WitokPaths, isRuntimeServicePath, isWitokArtifactName } from '../src/artifacts/paths.ts';

describe('раскладка артефактов', () => {
  it('plan-vK.md — артефакт витка; служебные файлы раннера — в .runner/', () => {
    const p = new WitokPaths('D:/proj', 'demo');
    ok(p.planArchive(2).replace(/\\/g, '/').endsWith('.sdlc/demo/plan-v2.md'));
    strictEqual(isWitokArtifactName('plan-v3.md'), true);
    ok(p.iterations.replace(/\\/g, '/').endsWith('.sdlc/demo/.runner/iterations.md'));
    ok(p.selfReview(1, 2).replace(/\\/g, '/').endsWith('.sdlc/demo/self-review-1-attempt-2.md'), 'самопросмотр пишет модель — вне закрытого .runner/');
    ok(p.chunkReviewText(1, 2).replace(/\\/g, '/').endsWith('.sdlc/demo/chunk-1-attempt-2-review.md'));
    strictEqual(isWitokArtifactName('chunk-1-attempt-2-review.md'), true);
    strictEqual(isRuntimeServicePath('.Runner/metrics.json'), true, 'без учёта регистра');
    strictEqual(isRuntimeServicePath('.intent-sections.json'), false, 'снимок секций задачи — артефакт методологии, коммитится');
    ok(p.verificationReport(1, 1, 2).replace(/\\/g, '/').endsWith('.runner/verification-report-1-attempt-1-r2.md'));
    ok(p.verificationReport(1, 1).replace(/\\/g, '/').endsWith('.sdlc/demo/verification-report-1-attempt-1.md'));
    ok(p.chunkBaseline(1).replace(/\\/g, '/').endsWith('.sdlc/demo/.chunk-1-baseline.json'), 'база читается инструментами методологии — остаётся в корне');
    strictEqual(isRuntimeServicePath('.runner/metrics.json'), true);
    strictEqual(isRuntimeServicePath('.chunk-1-baseline.json'), true);
    strictEqual(isRuntimeServicePath('plan-v1.md'), false);
    strictEqual(isRuntimeServicePath('chunk-1-attempt-1-evidence.json'), false);
  });
});
