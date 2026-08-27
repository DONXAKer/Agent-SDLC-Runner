/**
 * Ручной интеграционный smoke-тест песочницы против РЕАЛЬНОГО Docker и реальной спеки CV.
 *
 * Не входит в `npm test` (не матчится паттерном `test/**\/*.test.ts`) — сборка образа
 * занимает минуту-две и требует Docker на хосте; гонять это на каждый `npm test` было бы
 * тем же самым классом боли, которого сборка гейтов уже насмотрелась в AUTH-104. Запускается
 * руками: `node --test server/test/sandbox.docker.smoke.ts`.
 */

import { strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createDockerSandbox, stopDockerSandbox } from '../src/sandbox/dockerSandbox.ts';
import { loadSandboxSpec, sandboxSpecPath } from '../src/sandbox/spec.ts';

const CV_ROOT = '/Users/home/Code/CV';

describe('DockerSandbox против реальной спеки CV', { timeout: 5 * 60_000 }, () => {
  it('спека CV существует и разбирается', () => {
    const spec = loadSandboxSpec(CV_ROOT);
    strictEqual(spec !== null, true, `нет ${sandboxSpecPath(CV_ROOT)}`);
  });

  it('образ собирается, контейнер стартует, пробы JDK 21 / Node 22 / docker зелёные', async () => {
    const spec = loadSandboxSpec(CV_ROOT);
    if (spec === null) throw new Error('спека не найдена');

    const handle = await createDockerSandbox(CV_ROOT, 'cv', spec);
    try {
      const probes = await handle.runProbes();
      for (const p of probes) {
        console.log(`  проба «${p.cmd}»: ${p.ok ? 'OK' : 'FAIL'} — ${p.output.split('\n')[0]}`);
      }
      strictEqual(
        probes.every((p) => p.ok),
        true,
        `упавшие пробы: ${probes.filter((p) => !p.ok).map((p) => p.cmd).join(', ')}`,
      );

      // gates.md CV зовёт `cd backend && ./mvnw -q -DskipTests package` — тот же путь, что
      // и настоящий гейт «Сборка», проверяем именно им, а не голым `java -version`.
      const mvnCheck = await handle.exec.exec('cd backend && ./mvnw -v', {
        cwd: CV_ROOT,
        timeoutMs: 120_000,
      });
      console.log(`  ./mvnw -v → код ${mvnCheck.exitCode}\n${mvnCheck.stdout.split('\n').slice(0, 4).join('\n')}`);
      strictEqual(mvnCheck.exitCode, 0);
      strictEqual(/Java version: 21/.test(mvnCheck.stdout), true);
    } finally {
      await stopDockerSandbox('cv', handle.specHash);
    }
  });
});
