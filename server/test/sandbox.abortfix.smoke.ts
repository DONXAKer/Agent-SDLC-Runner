/**
 * Ручной smoke-тест исправления `onAbort`: контейнер обязан ПЕРЕЖИТЬ отмену одной команды.
 *
 * Запуск: `node --test server/test/sandbox.abortfix.smoke.ts`.
 */

import { strictEqual } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { createDockerSandbox, stopDockerSandbox } from '../src/sandbox/dockerSandbox.ts';
import { specHash } from '../src/sandbox/dockerfile.ts';
import type { SandboxSpec } from '../src/sandbox/types.ts';

describe('onAbort убивает только отменённую команду, контейнер выживает', { timeout: 2 * 60_000 }, () => {
  it('долгая команда отменяется, вторая команда после неё в том же контейнере отвечает', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sdlc-abortfix-'));
    try {
      mkdirSync(join(dir, '.sdlc'));
      const spec: SandboxSpec = { base: 'debian:12-slim', toolchains: {} };
      writeFileSync(join(dir, '.sdlc', 'sandbox.json'), JSON.stringify(spec));

      const handle = await createDockerSandbox(dir, 'abortfix-project', spec);
      try {
        const controller = new AbortController();
        const longRun = handle.exec.exec('sleep 30', { cwd: dir, timeoutMs: 60_000, signal: controller.signal });

        // Дать команде реально стартовать внутри контейнера, потом отменить.
        await new Promise((r) => setTimeout(r, 1500));
        controller.abort();
        const r1 = await longRun;
        console.log(`  отменённая команда: exitCode=${r1.exitCode} timedOut=${r1.timedOut}`);

        // Контейнер обязан быть ЖИВ и отвечать на следующую команду — старый `kill -1`
        // убивал весь контейнер, и это упало бы здесь с "is not running"/зависанием.
        const r2 = await handle.exec.exec('echo alive', { cwd: dir, timeoutMs: 10_000 });
        console.log(`  проверка живости после отмены: "${r2.stdout.trim()}"`);
        strictEqual(r2.exitCode, 0);
        strictEqual(r2.stdout.trim(), 'alive');
      } finally {
        await stopDockerSandbox('abortfix-project', specHash(spec));
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('in-container timeout реально обрывает зависшую команду (тот же wrapper, что теперь и в execInContainer/warmup)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sdlc-timeout-'));
    try {
      mkdirSync(join(dir, '.sdlc'));
      const spec: SandboxSpec = { base: 'debian:12-slim', toolchains: {} };
      writeFileSync(join(dir, '.sdlc', 'sandbox.json'), JSON.stringify(spec));

      const handle = await createDockerSandbox(dir, 'timeout-project', spec);
      try {
        const started = Date.now();
        const r = await handle.exec.exec('sleep 30', { cwd: dir, timeoutMs: 2_000 });
        const elapsed = Date.now() - started;
        console.log(`  sleep 30 с таймаутом 2с → timedOut=${r.timedOut}, реально заняло ${elapsed}мс`);
        strictEqual(r.timedOut, true);
        // С запасом — не 2000мс ровно (in-container `timeout -k 2` + сетевой round-trip),
        // но далеко не 30с, которые команда просила бы без ограничения.
        strictEqual(elapsed < 10_000, true, `таймаут не сработал вовремя: ${elapsed}мс`);
      } finally {
        await stopDockerSandbox('timeout-project', specHash(spec));
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
