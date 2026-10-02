import { strictEqual } from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { finalizeRejection } from '../src/artifacts/finalizeCheck.ts';

const roots: string[] = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

describe('FinalizeArtifact stage path correction', () => {
  it('resolves the exact known .sdlc artifact when the model wraps its filename in parentheses', () => {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-finalize-path-'));
    roots.push(root);
    const artifact = join(root, '.sdlc', 'run', 'intent.md');
    mkdirSync(join(root, '.sdlc', 'run'), { recursive: true });
    writeFileSync(artifact, '# Intent\n\nContent.\n');
    strictEqual(finalizeRejection('.sdlc/run(intent.md)', root, [artifact]), null);
    strictEqual(finalizeRejection('.sdlc/other-run(intent.md)', root, [artifact])?.message.includes('артефактом'), true);
  });
});
