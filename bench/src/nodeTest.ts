/**
 * Дочерний `node --test` — один спавн для обвязки (`hiddenTests.ts`) и для помощника
 * скрытых тестов (`checks/hidden/lib/spawnTests.mjs`).
 *
 * `NODE_TEST_CONTEXT`/`NODE_TEST_WORKER_ID` наследуются от `process.env`, когда вызывающий
 * сам запущен из-под `node --test` (бенчмарк — из своего теста, скрытый тест — всегда):
 * дочерний узел видит себя «внутри уже идущего прогона» и молча пропускает файл вместо
 * запуска — вывод пуст, будто тестов не было ни одного. Гасим обе; в двух местах эта гоча
 * жила бы двумя копиями, и починка одной не чинила бы другую.
 */

import { spawn } from 'node:child_process';

export interface NodeTestOutput {
  /** `null` — процесс не запустился или снят по таймауту. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export function spawnNodeTest(args: {
  testArgs: readonly string[];
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}): Promise<NodeTestOutput> {
  return new Promise((resolve) => {
    const { NODE_TEST_CONTEXT: _ctx, NODE_TEST_WORKER_ID: _worker, ...cleanEnv } = process.env;
    const child = spawn(process.execPath, ['--test', '--test-reporter=tap', ...args.testArgs], {
      env: { ...cleanEnv, ...(args.env ?? {}) },
      windowsHide: true,
      ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
    });
    const out: string[] = [];
    const err: string[] = [];
    let timedOut = false;
    child.stdout.on('data', (d: Buffer) => out.push(d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => err.push(d.toString('utf8')));
    const timer =
      args.timeoutMs === undefined
        ? null
        : setTimeout(() => {
            timedOut = true;
            child.kill();
          }, args.timeoutMs);
    child.on('close', (code) => {
      if (timer !== null) clearTimeout(timer);
      resolve({ exitCode: code, stdout: out.join(''), stderr: err.join(''), timedOut });
    });
    child.on('error', (e) => {
      if (timer !== null) clearTimeout(timer);
      resolve({ exitCode: null, stdout: '', stderr: e.message, timedOut });
    });
  });
}
