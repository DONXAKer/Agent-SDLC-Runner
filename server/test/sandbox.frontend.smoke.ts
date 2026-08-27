/**
 * Ручной smoke-тест: гейты фронта CV (`npm run build`, `npm run lint`) через новый,
 * целиком-скопированный Node-слой — регресс на баг «npm ci падает из-за поломанных
 * относительных require» (см. коммит, чинящий `dockerfile.ts::nodeLayer`).
 *
 * Запуск: `node --test server/test/sandbox.frontend.smoke.ts`.
 */

import { strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runShell } from '../src/gates/shell.ts';
import { ensureSandboxFor, unregisterSandbox } from '../src/sandbox/registry.ts';
import { stopDockerSandbox } from '../src/sandbox/dockerSandbox.ts';

const CV_ROOT = '/Users/home/Code/CV';

describe('гейты фронта CV через песочницу', { timeout: 10 * 60_000 }, () => {
  it('npm run build (tsc -b && vite build) проходит в песочнице', async () => {
    const handle = await ensureSandboxFor(CV_ROOT, 'cv');
    strictEqual(handle !== null, true);
    try {
      const r = await runShell('cd frontend && npm run build', { cwd: CV_ROOT, timeoutMs: 5 * 60_000 });
      console.log(`  npm run build → код ${r.exitCode}: ${r.lastLine}`);
      strictEqual(r.denied, null);
      strictEqual(r.exitCode, 0, r.stdout.slice(-3000) + '\n' + r.stderr.slice(-3000));
    } finally {
      if (handle) await stopDockerSandbox('cv', handle.specHash);
      unregisterSandbox(CV_ROOT);
    }
  });

  it('npm run lint (oxlint) проходит в песочнице', async () => {
    const handle = await ensureSandboxFor(CV_ROOT, 'cv');
    strictEqual(handle !== null, true);
    try {
      const r = await runShell('cd frontend && npm run lint', { cwd: CV_ROOT, timeoutMs: 2 * 60_000 });
      console.log(`  npm run lint → код ${r.exitCode}: ${r.lastLine}`);
      strictEqual(r.denied, null);
      strictEqual(r.exitCode, 0, r.stdout.slice(-3000) + '\n' + r.stderr.slice(-3000));
    } finally {
      if (handle) await stopDockerSandbox('cv', handle.specHash);
      unregisterSandbox(CV_ROOT);
    }
  });
});
