/**
 * `attemptHadBash` (`run/stages/chunk/evidence.ts`) — часть стража завершения chunk'а
 * (Р3, серия local6 2026-09-24): «дерево не тронуто» обязано учитывать и правку через
 * Bash (`sed`/`patch`), не только Write/Edit, которые считает `acceptedWrites` (`Run.ts`).
 *
 * Фикстуры событий — тем же приёмом, что у `honesty.test.ts`: пара `tool_request`/
 * `tool_result` с общим `requestId`, как лента выглядит на самом деле.
 */

import { strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { RunEvent } from '@sdlc-runner/shared';

import { attemptHadBash } from '../src/run/stages/chunk/evidence.ts';

function bashCall(command: string, requestId = 'x', ok = true): RunEvent[] {
  const request: RunEvent = {
    type: 'tool_request',
    runId: 'r',
    stage: 'chunk',
    requestId,
    toolName: 'Bash',
    rawInput: { command },
    call: { kind: 'bash', command },
    policy: { ok: true },
    preview: null,
    writeTargets: null,
    destructive: null,
    createdAt: 0,
  };
  const result: RunEvent = {
    type: 'tool_result',
    runId: 'r',
    stage: 'chunk',
    requestId,
    ok,
    summary: ok ? 'код возврата 0' : 'код возврата 1',
    durationMs: 1,
  };
  return [request, result];
}

function readCall(requestId = 'y'): RunEvent[] {
  const request: RunEvent = {
    type: 'tool_request',
    runId: 'r',
    stage: 'chunk',
    requestId,
    toolName: 'Read',
    rawInput: { file_path: 'src/a.ts' },
    call: { kind: 'read', path: 'src/a.ts', range: null },
    policy: { ok: true },
    preview: null,
    writeTargets: null,
    destructive: null,
    createdAt: 0,
  };
  const result: RunEvent = {
    type: 'tool_result',
    runId: 'r',
    stage: 'chunk',
    requestId,
    ok: true,
    summary: 'прочитан',
    durationMs: 1,
  };
  return [request, result];
}

describe('attemptHadBash', () => {
  it('пустая лента — false', () => {
    strictEqual(attemptHadBash([]), false);
  });

  it('только чтения — false', () => {
    strictEqual(attemptHadBash(readCall()), false);
  });

  it('успешный Bash — true', () => {
    strictEqual(attemptHadBash(bashCall('sed -i "s/a/b/" src/x.ts')), true);
  });

  it('Bash, упавший ошибкой, — false: команда не исполнилась результативно', () => {
    strictEqual(attemptHadBash(bashCall('sed -i "s/a/b/" src/x.ts', 'x', false)), false);
  });

  it('чтения и успешный Bash вперемешку — true', () => {
    strictEqual(attemptHadBash([...readCall('r1'), ...bashCall('patch -p1 < fix.diff', 'r2')]), true);
  });
});
