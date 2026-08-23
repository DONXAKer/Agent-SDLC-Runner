/**
 * Ручной smoke-тест pre-flight'а против реального Docker: и позитивный, и негативный случай.
 *
 * Запуск: `node --test server/test/sandbox.preflight.smoke.ts`.
 */

import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { preflightBlockers } from '../src/sandbox/preflight.ts';
import { specHash } from '../src/sandbox/dockerfile.ts';
import { stopDockerSandbox } from '../src/sandbox/dockerSandbox.ts';
import { loadSandboxSpec } from '../src/sandbox/spec.ts';
import { unregisterSandbox } from '../src/sandbox/registry.ts';

const CV_ROOT = '/Users/home/Code/CV';

async function cleanup(projectRoot: string, projectName: string): Promise<void> {
  const spec = loadSandboxSpec(projectRoot);
  if (spec !== null) await stopDockerSandbox(projectName, specHash(spec));
  unregisterSandbox(projectRoot);
}

describe('preflightBlockers против реального Docker', { timeout: 5 * 60_000 }, () => {
  it('спека CV в порядке — пустой список блокеров', async () => {
    const blockers = await preflightBlockers(CV_ROOT, 'cv-preflight-check');
    deepStrictEqual(blockers, []);
    await cleanup(CV_ROOT, 'cv-preflight-check');
  });

  it('спека требует несуществующую версию JDK — проба падает, блокер называет команду', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sdlc-preflight-bad-'));
    try {
      mkdirSync(join(dir, '.sdlc'));
      writeFileSync(
        join(dir, '.sdlc', 'sandbox.json'),
        JSON.stringify({
          base: 'debian:12-slim',
          toolchains: { jdk: { version: '21', dist: 'temurin' } },
          probes: [{ cmd: 'java -version', expect: '"999\\.' }], // заведомо не совпадёт
        }),
      );
      const blockers = await preflightBlockers(dir, 'preflight-bad-project');
      strictEqual(blockers.length, 1);
      strictEqual(/java -version/.test(blockers[0] ?? ''), true);
      console.log(`  блокер: ${blockers[0]}`);
      await cleanup(dir, 'preflight-bad-project');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
