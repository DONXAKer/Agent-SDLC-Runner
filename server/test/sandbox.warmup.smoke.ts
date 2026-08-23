/**
 * Ручной smoke-тест прогрева/кэша (реальная спека CV) и отключения сети после прогрева
 * (синтетическая спека) против реального Docker.
 *
 * Запуск: `node --test server/test/sandbox.warmup.smoke.ts`.
 */

import { strictEqual } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { createDockerSandbox, stopDockerSandbox } from '../src/sandbox/dockerSandbox.ts';
import { specHash } from '../src/sandbox/dockerfile.ts';
import { loadSandboxSpec } from '../src/sandbox/spec.ts';
import type { SandboxSpec } from '../src/sandbox/types.ts';

const CV_ROOT = '/Users/home/Code/CV';

describe('прогрев и кэш — реальная спека CV', { timeout: 10 * 60_000 }, () => {
  it('warmup наполняет ~/.m2 из именованного тома, контейнер живёт после', async () => {
    const spec = loadSandboxSpec(CV_ROOT);
    if (spec === null) throw new Error('нет .sdlc/sandbox.json у CV');
    strictEqual(Array.isArray(spec.warmup) && spec.warmup.length > 0, true, 'ожидался warmup в спеке CV');

    const handle = await createDockerSandbox(CV_ROOT, 'cv', spec);
    try {
      const r = await handle.exec.exec('find ~/.m2/repository -name "*.jar" | wc -l', {
        cwd: CV_ROOT,
        timeoutMs: 30_000,
      });
      const jarCount = parseInt(r.stdout.trim(), 10);
      console.log(`  .m2 после прогрева: ${jarCount} jar-файлов`);
      strictEqual(jarCount > 10, true, `прогрев не наполнил кэш (${r.stdout}${r.stderr})`);

      const probes = await handle.runProbes();
      strictEqual(
        probes.every((p) => p.ok),
        true,
      );
    } finally {
      await stopDockerSandbox('cv', specHash(spec));
    }
  });
});

describe('network: none — синтетическая спека', { timeout: 5 * 60_000 }, () => {
  it('после прогрева контейнер лишается сети, но сокет докера остаётся живым', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sdlc-network-none-'));
    try {
      mkdirSync(join(dir, '.sdlc'));
      const spec: SandboxSpec = {
        base: 'debian:12-slim',
        toolchains: {},
        docker: 'socket',
        warmup: ['echo прогрев-был-тут'],
        network: 'none',
      };
      writeFileSync(join(dir, '.sdlc', 'sandbox.json'), JSON.stringify(spec));

      const handle = await createDockerSandbox(dir, 'network-none-project', spec);
      try {
        const net = await handle.exec.exec(
          'curl -fsS --max-time 3 -o /dev/null -w "%{http_code}" https://1.1.1.1 || echo NETDOWN',
          { cwd: dir, timeoutMs: 15_000 },
        );
        console.log(`  сеть после отключения: ${net.stdout.trim()}${net.stderr.trim()}`);
        strictEqual(/NETDOWN/.test(net.stdout + net.stderr), true, 'сеть должна быть недоступна после network:none');

        const socket = await handle.exec.exec('docker info', { cwd: dir, timeoutMs: 15_000 });
        strictEqual(socket.exitCode, 0, 'сокет докера обязан остаться живым — это файл, не сеть');
      } finally {
        await stopDockerSandbox('network-none-project', specHash(spec));
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
