/**
 * Запись собственного артефакта этапа не по его пути — рантайм подставляет канонический
 * путь до политики (`approval/artifactAddress.ts`), а не отклоняет вызов как «вне плана».
 *
 * Живой класс серий test27–test29 (2026-09-22…23): `clarification-report.md` по голому
 * имени и в каталоге витка с опечаткой в слаге — отчёт стенда ставил метку «опасна» за
 * ошибку адресации, а этап оставался без артефакта.
 */

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { PolicyContext } from '@sdlc-runner/shared';

import { readdressOwnArtifact, withReaddressedPath } from '../src/approval/artifactAddress.ts';
import { ApprovalGate } from '../src/approval/gate.ts';
import type { PendingApproval } from '../src/approval/gate.ts';
import { isWitokArtifactName } from '../src/artifacts/paths.ts';

const ROOT = '/proj';
const REPORT = '/proj/.sdlc/demo/clarification-report.md';

function ctx(over: Partial<PolicyContext> = {}): PolicyContext {
  return {
    projectRoot: ROOT,
    stage: 'ask',
    sdlcDir: '.sdlc/demo',
    planFiles: null,
    protectedArtifacts: [],
    readOnlyRoots: [],
    allowedTools: ['Read', 'Write', 'Edit'],
    mcpTools: [],
    stageArtifacts: [{ key: 'clarification', path: REPORT }],
    ...over,
  };
}

describe('readdressOwnArtifact', () => {
  it('голое имя артефакта этапа → канонический путь', () => {
    const r = readdressOwnArtifact({ kind: 'write', path: 'clarification-report.md', content: 'x' }, ctx());
    deepStrictEqual(r, { from: 'clarification-report.md', to: REPORT, key: 'clarification' });
  });

  it('опечатка в слаге витка → канонический путь (test29: freesship вместо freeship)', () => {
    const r = readdressOwnArtifact(
      { kind: 'edit', path: '.sdlc/demoo/clarification-report.md', edits: [{ oldStr: 'a', newStr: 'b', replaceAll: false }] },
      ctx(),
    );
    strictEqual(r?.to, REPORT);
  });

  it('канонический путь (относительный или абсолютный) — перенаправлять нечего', () => {
    strictEqual(readdressOwnArtifact({ kind: 'write', path: '.sdlc/demo/clarification-report.md', content: 'x' }, ctx()), null);
    strictEqual(readdressOwnArtifact({ kind: 'write', path: REPORT, content: 'x' }, ctx()), null);
  });

  it('чужое имя, чтение и Bash не трогаются', () => {
    strictEqual(readdressOwnArtifact({ kind: 'write', path: 'notes.md', content: 'x' }, ctx()), null);
    strictEqual(readdressOwnArtifact({ kind: 'read', path: 'clarification-report.md', range: null }, ctx()), null);
    strictEqual(readdressOwnArtifact({ kind: 'bash', command: 'echo x > clarification-report.md' }, ctx()), null);
  });

  it('путь вне проекта не перенаправляется — это выход за границу, его судит pathScope', () => {
    strictEqual(readdressOwnArtifact({ kind: 'write', path: '../../clarification-report.md', content: 'x' }, ctx()), null);
    strictEqual(readdressOwnArtifact({ kind: 'write', path: '/etc/clarification-report.md', content: 'x' }, ctx()), null);
  });

  it('то же имя в продуктовом каталоге на этапах 1–4 (planFiles нет) не перенаправляется', () => {
    const c = ctx({ stage: 'plan', stageArtifacts: [{ key: 'plan', path: '/proj/.sdlc/demo/plan.md' }] });
    strictEqual(readdressOwnArtifact({ kind: 'write', path: 'docs/plan.md', content: 'x' }, c), null);
    strictEqual(readdressOwnArtifact({ kind: 'write', path: 'plan.md', content: 'x' }, c)?.to, '/proj/.sdlc/demo/plan.md');
  });

  it('флоу sdk (noArtifactReaddress) — не перенаправляется: харнесс требует чтения самого пути', () => {
    strictEqual(
      readdressOwnArtifact({ kind: 'write', path: 'clarification-report.md', content: 'x' }, ctx({ noArtifactReaddress: true })),
      null,
    );
  });

  it('этап не производит артефактов — перенаправлять некуда', () => {
    strictEqual(readdressOwnArtifact({ kind: 'write', path: 'plan.md', content: 'x' }, ctx({ stageArtifacts: [] })), null);
  });

  it('файл плана с тем же базовым именем — продуктовый файл, не заблудившийся артефакт', () => {
    const c = ctx({
      stage: 'chunk',
      planFiles: ['docs/plan.md'],
      stageArtifacts: [{ key: 'journal', path: '/proj/.sdlc/demo/chunk-1-journal.md' }, { key: 'plan', path: '/proj/.sdlc/demo/plan.md' }],
    });
    strictEqual(readdressOwnArtifact({ kind: 'write', path: 'docs/plan.md', content: 'x' }, c), null);
  });

  it('Windows-корень: регистр и обратные слэши не мешают сравнению', () => {
    const c = ctx({ projectRoot: 'D:/Proj', stageArtifacts: [{ key: 'clarification', path: 'D:\\Proj\\.sdlc\\demo\\clarification-report.md' }] });
    const r = readdressOwnArtifact({ kind: 'write', path: 'Clarification-Report.md', content: 'x' }, c);
    strictEqual(r?.to, 'D:/Proj/.sdlc/demo/clarification-report.md');
    strictEqual(readdressOwnArtifact({ kind: 'write', path: 'd:/proj/.sdlc/demo/clarification-report.md', content: 'x' }, c), null);
  });
});

describe('withReaddressedPath', () => {
  it('путь подставляется под тем ключом, под которым пришёл', () => {
    deepStrictEqual(withReaddressedPath({ path: 'a.md', content: 'x' }, '/p/a.md'), { path: '/p/a.md', content: 'x' });
    deepStrictEqual(withReaddressedPath({ file_path: 'a.md', old_string: 'a', new_string: 'b' }, '/p/a.md'), {
      file_path: '/p/a.md',
      old_string: 'a',
      new_string: 'b',
    });
  });
});

describe('isWitokArtifactName', () => {
  it('канонические имена артефактов витка узнаются, служебные и чужие — нет', () => {
    for (const n of ['intent.md', 'plan.md', 'clarification-report.md', 'chunk-2-journal.md', 'verification-report-1-attempt-2-r1.md', 'self-review-1-attempt-1.md']) {
      ok(isWitokArtifactName(n), n);
    }
    for (const n of ['.events.ndjson', 'metrics.json', 'notes.md', 'README.md', 'chunk-journal.md']) {
      ok(!isWitokArtifactName(n), n);
    }
  });
});

describe('ApprovalGate: перенаправление адреса своего артефакта', () => {
  function request(gate: ApprovalGate, path: string, c: PolicyContext = ctx()) {
    return gate.request({
      runId: 'r1',
      stage: 'ask',
      requestId: `w-${Math.random()}`,
      toolName: 'Write',
      rawInput: { file_path: path, content: '# Отчёт' },
      call: { kind: 'write', path, content: '# Отчёт' },
      ctx: c,
    });
  }

  it('голое имя: политика судит канонический путь, оператор видит пометку, одобрение уносит новый путь', async () => {
    const events: PendingApproval[] = [];
    const gate = new ApprovalGate({ onPending: (p) => events.push(p), onResolved: () => {} });
    const pending = request(gate, 'clarification-report.md');
    const card = gate.list()[0]!;
    ok(card.policy.ok, `до правки planScope отклонял запись как «вне плана»: ${JSON.stringify(card.policy)}`);
    ok(card.readdressed?.includes('clarification-report.md'), card.readdressed);
    strictEqual(card.call.kind === 'write' ? card.call.path : null, REPORT);
    strictEqual(events[0]?.readdressed, card.readdressed);
    gate.resolve('r1', card.requestId, { allowed: true, updatedInput: null, by: 'operator' });
    const d = await pending;
    ok(d.allowed);
    strictEqual((d.updatedInput as Record<string, unknown> | null)?.['file_path'], REPORT);
  });

  it('автоодобрение уносит перенаправленный путь исполнителю', async () => {
    const gate = new ApprovalGate({ onPending: () => {}, onResolved: () => {} });
    gate.setAutoApprove('r1', 'ask', { planWrites: false, bash: false, rest: true, mcpWrites: false });
    const d = await request(gate, '.sdlc/demoo/clarification-report.md');
    ok(d.allowed);
    strictEqual((d.updatedInput as Record<string, unknown> | null)?.['file_path'], REPORT);
  });

  it('канонический путь — пометки нет, вход не трогается', async () => {
    const gate = new ApprovalGate({ onPending: () => {}, onResolved: () => {} });
    gate.setAutoApprove('r1', 'ask', { planWrites: false, bash: false, rest: true, mcpWrites: false });
    const d = await request(gate, '.sdlc/demo/clarification-report.md');
    ok(d.allowed);
    strictEqual(d.updatedInput, null);
  });

  it('защищённый артефакт остаётся защищённым: перенаправление не открывает задачу на этапе 3', async () => {
    const gate = new ApprovalGate({ onPending: () => {}, onResolved: () => {} });
    const c = ctx({
      protectedArtifacts: ['.sdlc/demo/intent.md'],
      stageArtifacts: [
        { key: 'clarification', path: REPORT },
        { key: 'intent', path: '/proj/.sdlc/demo/intent.md' },
      ],
    });
    const d = await request(gate, 'intent.md', c);
    strictEqual(d.allowed, false);
    ok(d.reason.includes('[planScope]'), d.reason);
  });
});
