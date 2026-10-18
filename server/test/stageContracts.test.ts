import { deepStrictEqual, ok } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WitokPaths } from '../src/artifacts/paths.ts';
import { stageInputs, stageOutputContracts } from '../src/run/stages/inputs.ts';
import { STAGES } from '../src/run/stages/index.ts';

describe('контракты входов и выходов этапов', () => {
  it('каждый из семи этапов имеет адресованные входы и выходы с происхождением и актуальностью', () => {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-stage-contract-'));
    try {
      const ctx = { paths: new WitokPaths(root, 'contract-check'), chunk: 2, attempt: 3 };
      deepStrictEqual(STAGES.map((stage) => stage.id), ['intent', 'explore', 'ask', 'plan', 'chunk', 'verify', 'handoff']);
      for (const stage of STAGES) {
        const inputs = stageInputs(stage.id, ctx);
        const outputs = stageOutputContracts(stage, ctx);
        ok(inputs.length > 0, `${stage.id}: нет входов`);
        ok(outputs.length > 0, `${stage.id}: нет выходов`);
        for (const item of inputs) {
          ok(item.path.length > 0 && item.purpose.length > 0, `${stage.id}: пустой входной контракт`);
          ok(item.origin.length > 0 && item.freshness.length > 0, `${stage.id}: нет происхождения/актуальности входа`);
        }
        for (const item of outputs) {
          ok(item.path.length > 0 && item.purpose.length > 0, `${stage.id}: пустой выходной контракт`);
          deepStrictEqual(item.origin, stage.id);
          ok(item.freshness.length > 0, `${stage.id}: нет актуальности выхода`);
        }
        deepStrictEqual(outputs.filter((item) => item.required).map((item) => item.path), stage.produces(ctx));
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
