/**
 * Правила автоодобрения.
 *
 * Главное — правило применяется ПОСЛЕ политики и не может её отменить, а «правки внутри
 * плана» означает ВСЕ цели внутри плана: одна цель вне — и это уже «остальное».
 */

import { ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { NormalizedCall, PolicyContext } from '@sdlc-runner/shared';

import { ApprovalGate } from '../src/approval/gate.ts';

const ctx = (planFiles: string[] | null): PolicyContext => ({
  projectRoot: '/proj',
  stage: 'chunk',
  sdlcDir: '.sdlc/x',
  planFiles,
  protectedArtifacts: [],
  readOnlyRoots: [],
  allowedTools: ['Read', 'Write', 'Edit', 'Bash'],
});

const write = (path: string): NormalizedCall => ({ kind: 'write', path, content: 'x' });
const bash = (command: string): NormalizedCall => ({ kind: 'bash', command });

function gate(): ApprovalGate {
  return new ApprovalGate({ onPending: () => {}, onResolved: () => {} });
}

async function ask(g: ApprovalGate, call: NormalizedCall, planFiles: string[] | null) {
  return g.request({
    runId: 'r1',
    stage: 'chunk',
    requestId: `id-${Math.random()}`,
    toolName: 'X',
    rawInput: {},
    call,
    ctx: ctx(planFiles),
  });
}

describe('правила автоодобрения', () => {
  it('правка внутри плана проходит по planWrites', async () => {
    const g = gate();
    g.setAutoApprove('r1', 'chunk', { planWrites: true, bash: false, rest: false });
    const d = await ask(g, write('src/a.ts'), ['src/a.ts']);
    strictEqual(d.allowed && d.by, 'auto');
  });

  it('правка ВНЕ плана по planWrites не проходит', async () => {
    const g = gate();
    g.setAutoApprove('r1', 'chunk', { planWrites: true, bash: false, rest: false });
    // Политика отклонит запись вне плана раньше — и это правильный порядок: правило
    // автоодобрения не может отменить отказ политики.
    const d = await ask(g, write('src/b.ts'), ['src/a.ts']);
    strictEqual(d.allowed, false);
  });

  it('bash отделён от правок: planWrites его не пропускает', async () => {
    const g = gate();
    g.setAutoApprove('r1', 'chunk', { planWrites: true, bash: false, rest: false });
    const pending = ask(g, bash('ls'), ['src/a.ts']);
    // Вызов встал в очередь к человеку — значит правило его не пропустило.
    strictEqual(g.list().length, 1);
    g.resolve('r1', g.list()[0]!.requestId, { allowed: false, reason: 'нет', by: 'operator' });
    strictEqual((await pending).allowed, false);
  });

  it('bash проходит только по своему правилу', async () => {
    const g = gate();
    g.setAutoApprove('r1', 'chunk', { planWrites: false, bash: true, rest: false });
    const d = await ask(g, bash('ls'), ['src/a.ts']);
    strictEqual(d.allowed && d.by, 'auto');
  });

  it('выключенные правила спрашивают всё', async () => {
    const g = gate();
    const rules = g.autoApproveRules('r1', 'chunk');
    ok(!rules.planWrites && !rules.bash && !rules.rest);
  });

  it('правила снимаются вместе с этапом', async () => {
    const g = gate();
    g.setAutoApprove('r1', 'chunk', { planWrites: true, bash: true, rest: true });
    g.clearAutoApprove('r1', 'chunk');
    const rules = g.autoApproveRules('r1', 'chunk');
    ok(!rules.planWrites && !rules.bash && !rules.rest);
  });
});
