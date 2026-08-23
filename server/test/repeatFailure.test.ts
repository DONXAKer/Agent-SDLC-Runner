/**
 * Защита от зацикливания одинаковых падающих команд (A7 ретроспективы AUTH-104).
 *
 * Наблюдение живого витка: рецензент прогнал ~10 раз подряд одинаковую падающую команду,
 * прерван вручную оператором через reject. `ApprovalGate.recordBashResult` +
 * проверка в `request()` — механическая остановка вместо ручной.
 */

import { ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { NormalizedCall, PolicyContext } from '@sdlc-runner/shared';

import { ApprovalGate } from '../src/approval/gate.ts';

const ctx: PolicyContext = {
  projectRoot: '/proj',
  stage: 'chunk',
  sdlcDir: '.sdlc/x',
  planFiles: null,
  protectedArtifacts: [],
  readOnlyRoots: [],
  allowedTools: ['Read', 'Write', 'Edit', 'Bash'],
};

const bash = (command: string): NormalizedCall => ({ kind: 'bash', command });

function gate(): ApprovalGate {
  const g = new ApprovalGate({ onPending: () => {}, onResolved: () => {} });
  // Автоодобрение bash — иначе `request()` для разрешённого политикой вызова повисает на
  // промисе, ждущем ответа оператора, которого в этом тесте нет: тест проверяет счётчик
  // повторов, а не очередь ручных одобрений.
  g.setAutoApprove('r1', 'chunk', { planWrites: false, bash: true, rest: false });
  g.setAutoApprove('r2', 'chunk', { planWrites: false, bash: true, rest: false });
  return g;
}

let seq = 0;
async function ask(g: ApprovalGate, call: NormalizedCall) {
  seq += 1;
  return g.request({
    runId: 'r1',
    stage: 'chunk',
    requestId: `id-${seq}`,
    toolName: 'Bash',
    rawInput: {},
    call,
    ctx,
  });
}

describe('защита от зацикливания одинаковых падающих команд', () => {
  it('одна и та же падающая команда 4-й раз подряд отклоняется без похода к оператору', async () => {
    const g = gate();
    for (let i = 0; i < 3; i++) {
      const d = await ask(g, bash('./mvnw test'));
      ok(d.allowed, `попытка ${i + 1} должна пройти политику`);
      g.recordBashResult('r1', './mvnw test', false);
    }
    const fourth = await ask(g, bash('./mvnw test'));
    strictEqual(fourth.allowed, false);
    ok(!fourth.allowed && /repeatFailure/.test(fourth.reason), JSON.stringify(fourth));
  });

  it('успех сбрасывает счётчик — следующий повтор снова проходит', async () => {
    const g = gate();
    for (let i = 0; i < 3; i++) {
      await ask(g, bash('./mvnw test'));
      g.recordBashResult('r1', './mvnw test', false);
    }
    g.recordBashResult('r1', './mvnw test', true);
    const d = await ask(g, bash('./mvnw test'));
    ok(d.allowed, 'после успеха счётчик обязан обнулиться');
  });

  it('другая команда между провалами не считается тем же зацикливанием', async () => {
    const g = gate();
    g.recordBashResult('r1', './mvnw test', false);
    g.recordBashResult('r1', './mvnw test', false);
    g.recordBashResult('r1', 'ls', false);
    g.recordBashResult('r1', './mvnw test', false);
    const d = await ask(g, bash('./mvnw test'));
    ok(d.allowed, 'счётчик считает подряд одну и ту же команду, а не любые провалы вперемешку');
  });

  it('разные прогоны не делят счётчик', async () => {
    const g = gate();
    g.recordBashResult('r1', './mvnw test', false);
    g.recordBashResult('r1', './mvnw test', false);
    g.recordBashResult('r1', './mvnw test', false);
    seq += 1;
    const d = await g.request({
      runId: 'r2',
      stage: 'chunk',
      requestId: `id-${seq}`,
      toolName: 'Bash',
      rawInput: {},
      call: bash('./mvnw test'),
      ctx,
    });
    ok(d.allowed, 'прогон r2 не должен пострадать от счётчика прогона r1');
  });

  it('cancelRun чистит счётчик прогона', async () => {
    const g = gate();
    g.recordBashResult('r1', './mvnw test', false);
    g.recordBashResult('r1', './mvnw test', false);
    g.recordBashResult('r1', './mvnw test', false);
    g.cancelRun('r1', 'обрыв');
    // `cancelRun` снимает и автоодобрение (тот же префикс `runId:`) — восстанавливаем его,
    // иначе `ask` ниже проверял бы очередь ручных одобрений, а не счётчик повторов.
    g.setAutoApprove('r1', 'chunk', { planWrites: false, bash: true, rest: false });
    const d = await ask(g, bash('./mvnw test'));
    ok(d.allowed, 'после cancelRun счётчик не должен переживать прогон');
  });
});
