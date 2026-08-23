/**
 * Ручной smoke-тест: точка интеграции, которой реально пользуются гейты — `ensureSandboxFor`
 * + `runShell`, теми же командами, что стоят в `.sdlc/gates.md` CV. Не в `npm test` по той же
 * причине, что и `sandbox.docker.smoke.ts`: минуты на первую сборку/прогрев.
 *
 * Запуск: `node --test server/test/sandbox.runshell.smoke.ts`.
 */

import { strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runShell } from '../src/gates/shell.ts';
import { ensureSandboxFor, unregisterSandbox } from '../src/sandbox/registry.ts';
import { stopDockerSandbox } from '../src/sandbox/dockerSandbox.ts';

const CV_ROOT = '/Users/home/Code/CV';

describe('runShell маршрутизируется в песочницу CV через registry', { timeout: 15 * 60_000 }, () => {
  it('гейт «Сборка»: cd backend && ./mvnw -q -DskipTests package — идёт в DockerSandbox и проходит', async () => {
    const handle = await ensureSandboxFor(CV_ROOT, 'cv');
    strictEqual(handle !== null, true, 'ensureSandboxFor вернул null — спека не нашлась или сборка упала');

    try {
      const r = await runShell('cd backend && ./mvnw -q -DskipTests package', {
        cwd: CV_ROOT,
        timeoutMs: 10 * 60_000,
      });
      console.log(`  Сборка → код ${r.exitCode}, последняя строка: ${r.lastLine}`);
      strictEqual(r.denied, null);
      strictEqual(r.exitCode, 0, r.stdout.slice(-4000) + '\n' + r.stderr.slice(-4000));
    } finally {
      if (handle) await stopDockerSandbox('cv', handle.specHash);
      unregisterSandbox(CV_ROOT);
    }
  });
});
