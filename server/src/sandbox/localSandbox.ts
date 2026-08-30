/**
 * Спавн команды прямо в процессе Runner'а — сегодняшнее поведение `gates/shell.ts`,
 * вынесенное сюда как один из двух исполнителей `SandboxExec`. Используется всегда, когда
 * у проекта нет `.sdlc/sandbox.json`: ни один существующий проект не перестаёт работать от
 * появления песочницы.
 */

import { spawn } from 'node:child_process';

import type { SandboxExec, SandboxExecOptions, SandboxExecResult } from './types.ts';
import { cap } from './capture.ts';

export class LocalSandbox implements SandboxExec {
  readonly kind = 'local' as const;

  exec(command: string, opts: SandboxExecOptions): Promise<SandboxExecResult> {
    const started = Date.now();

    return new Promise<SandboxExecResult>((resolve) => {
      const child = spawn(command, {
        cwd: opts.cwd,
        shell: true,
        windowsHide: true,
        detached: process.platform !== 'win32',
      });

      const out: string[] = [];
      const err: string[] = [];
      let timedOut = false;
      let settled = false;

      const killTree = (): void => {
        if (child.pid === undefined) return;
        if (process.platform === 'win32') {
          const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
            windowsHide: true,
          });
          killer.on('error', () => child.kill());
        } else {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            child.kill('SIGKILL');
          }
        }
        setTimeout(() => finish(null, '\n[рантайм] процесс снят принудительно'), 2_000).unref();
      };

      const timer = setTimeout(() => {
        timedOut = true;
        killTree();
      }, opts.timeoutMs);

      const onAbort = (): void => killTree();
      // Уже отменённый сигнал события не даст — убиваем сразу (class sweep ревью-2).
      if (opts.signal?.aborted === true) onAbort();
      else opts.signal?.addEventListener('abort', onAbort, { once: true });

      child.stdout.on('data', (d: Buffer) => out.push(d.toString('utf8')));
      child.stderr.on('data', (d: Buffer) => err.push(d.toString('utf8')));

      const finish = (exitCode: number | null, extraErr?: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
        if (extraErr !== undefined) err.push(extraErr);
        resolve({
          exitCode,
          stdout: cap(out),
          stderr: cap(err),
          durationMs: Date.now() - started,
          timedOut,
        });
      };

      child.on('error', (e) => finish(null, `\n[рантайм] команда не запустилась: ${e.message}`));
      child.on('close', (code) => finish(code));
    });
  }
}

export const localSandbox = new LocalSandbox();
