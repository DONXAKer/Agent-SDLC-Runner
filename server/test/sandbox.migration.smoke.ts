/**
 * Ручной smoke-тест миграции кэш-томов legacy-имя → `projectSlug`-имя.
 *
 * Запуск: `node --experimental-strip-types --test server/test/sandbox.migration.smoke.ts`.
 * Требует Docker. Создаёт синтетический legacy-том с файлом-меткой, гоняет
 * `migrateLegacyCacheVolume`, проверяет, что метка доехала в новый том, а старый остался
 * нетронутым (миграция копирует, не перемещает).
 */

import { strictEqual } from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import { legacyCacheVolumeName, migrateLegacyCacheVolume } from '../src/sandbox/dockerSandbox.ts';
import { projectSlug } from '../src/sandbox/dockerfile.ts';

function runDocker(args: string[]): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn('docker', args, { windowsHide: true });
    const out: string[] = [];
    child.stdout.on('data', (d: Buffer) => out.push(d.toString('utf8')));
    child.on('close', (code) => resolve({ code, stdout: out.join('') }));
  });
}

describe('миграция кэш-тома: данные реально переносятся, старый том не трогается', { timeout: 2 * 60_000 }, () => {
  it('файл-метка из legacy-тома виден в новом после миграции', async () => {
    const projectName = `migration-smoke-${randomUUID().slice(0, 8)}`;
    const legacyName = legacyCacheVolumeName(projectName, '~/.m2');
    const newName = `sdlc-sandbox-cache-${projectSlug(projectName)}-root-.m2`;

    await runDocker(['volume', 'create', legacyName]);
    try {
      const marker = `marker-${randomUUID()}`;
      const write = await runDocker([
        'run', '--rm', '-v', `${legacyName}:/v`, 'busybox:stable', 'sh', '-c', `touch /v/${marker}`,
      ]);
      strictEqual(write.code, 0, 'не удалось подготовить legacy-том');

      await migrateLegacyCacheVolume(newName, legacyName);

      const readNew = await runDocker([
        'run', '--rm', '-v', `${newName}:/v`, 'busybox:stable', 'sh', '-c', `ls /v`,
      ]);
      strictEqual(readNew.stdout.includes(marker), true, `метка не доехала в новый том: ${readNew.stdout}`);

      const readLegacy = await runDocker([
        'run', '--rm', '-v', `${legacyName}:/v`, 'busybox:stable', 'sh', '-c', `ls /v`,
      ]);
      strictEqual(readLegacy.stdout.includes(marker), true, 'старый том не должен опустеть после копирования');
    } finally {
      await runDocker(['volume', 'rm', '-f', legacyName]);
      await runDocker(['volume', 'rm', '-f', newName]);
    }
  });

  it('повторный вызов — no-op, если новый том уже существует', async () => {
    const projectName = `migration-smoke-noop-${randomUUID().slice(0, 8)}`;
    const legacyName = legacyCacheVolumeName(projectName, '~/.m2');
    const newName = `sdlc-sandbox-cache-${projectSlug(projectName)}-root-.m2`;

    await runDocker(['volume', 'create', legacyName]);
    await runDocker(['volume', 'create', newName]);
    try {
      const marker = `should-not-appear-${randomUUID()}`;
      await runDocker(['run', '--rm', '-v', `${legacyName}:/v`, 'busybox:stable', 'sh', '-c', `touch /v/${marker}`]);

      await migrateLegacyCacheVolume(newName, legacyName);

      const readNew = await runDocker(['run', '--rm', '-v', `${newName}:/v`, 'busybox:stable', 'sh', '-c', 'ls /v']);
      strictEqual(readNew.stdout.includes(marker), false, 'новый том уже существовал — миграция обязана быть no-op');
    } finally {
      await runDocker(['volume', 'rm', '-f', legacyName]);
      await runDocker(['volume', 'rm', '-f', newName]);
    }
  });
});
