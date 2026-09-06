/**
 * Проверка шага 2 ROADMAP.md — автоответчик человека на настоящем `ApprovalGate`/`AskGate`,
 * без модели и без сети.
 *
 * Три вещи, которые обязаны быть доказаны: отказ политики не попадает в лог оператора (он
 * в `notMine`), разрушающая перезапись получает отказ, ответ на `AskHuman` приходит из
 * банка `fixture/human.json`.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { NormalizedCall, PolicyContext, Question } from '@sdlc-runner/shared';

import { ApprovalBus, AskBus, attachOperator, bankRegExp, emptyOperatorLog, readHumanScript } from '../src/operator.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const HUMAN_JSON = join(HERE, '..', 'fixture', 'human.json');

function baseCtx(root: string, overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    projectRoot: root,
    stage: 'chunk',
    sdlcDir: '.sdlc/bench-x',
    // План у этапа 5 есть ВСЕГДА: без `plan.md` рантайм туда не пускает, а с 2026-09-04
    // `planScope` действует и до плана (запись сужена до артефактов витка). `null` здесь
    // проверял бы состояние, которого в живом прогоне не бывает, и гейт одобрения — то,
    // ради чего эти кейсы и написаны, — до автоответчика бы не доехал.
    planFiles: ['src/tariffs.ts', 'src/discounts.ts', 'src/oversize.ts'],
    protectedArtifacts: [],
    readOnlyRoots: [],
    allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'AskHuman'],
    mcpTools: [],
    ...overrides,
  };
}

let seq = 0;
function requestId(): string {
  seq += 1;
  return `req-${seq}`;
}

describe('автоответчик человека (bench/src/operator.ts)', () => {
  it('отказ политики не попадает в лог оператора — уходит в notMine', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-bench-op-'));
    try {
      const bus = new ApprovalBus();
      const script = readHumanScript(HUMAN_JSON);
      const log = emptyOperatorLog();
      const runId = 'r1';
      const handle = attachOperator({ gate: bus, askGate: new AskBus(), runId: () => runId, script, log });

      // allowedTools без Write → stageTools отклоняет ДО очереди одобрений.
      const ctx = baseCtx(root, { allowedTools: ['Read'] });
      const call: NormalizedCall = { kind: 'write', path: 'src/new-file.ts', content: 'x\n' };
      const decision = await bus.gate.request({
        runId,
        stage: 'chunk',
        requestId: requestId(),
        toolName: 'Write',
        rawInput: { path: 'src/new-file.ts', content: 'x\n' },
        call,
        ctx,
      });

      strictEqual(decision.allowed, false, JSON.stringify(decision));
      ok(!decision.allowed && /stageTools/.test(decision.reason), JSON.stringify(decision));
      strictEqual(log.approvals.length, 0, 'отказ политики не должен попасть в лог одобрений оператора');
      strictEqual(log.notMine.length, 1);
      strictEqual(log.notMine[0]?.reason, 'policy');

      handle.detach();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('разрушающая перезапись получает отказ от автоответчика', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-bench-op-'));
    try {
      const bus = new ApprovalBus();
      const script = readHumanScript(HUMAN_JSON);
      const log = emptyOperatorLog();
      const runId = 'r2';
      const handle = attachOperator({ gate: bus, askGate: new AskBus(), runId: () => runId, script, log });

      mkdirSync(join(root, 'src'), { recursive: true });
      const target = join(root, 'src', 'tariffs.ts');
      const big = Array.from({ length: 200 }, (_, i) => `const line${i} = ${i};`).join('\n') + '\n';
      writeFileSync(target, big);

      const ctx = baseCtx(root);
      const call: NormalizedCall = { kind: 'write', path: 'src/tariffs.ts', content: 'export const x = 1;\n' };
      const decision = await bus.gate.request({
        runId,
        stage: 'chunk',
        requestId: requestId(),
        toolName: 'Write',
        rawInput: { path: 'src/tariffs.ts', content: 'export const x = 1;\n' },
        call,
        ctx,
      });

      strictEqual(decision.allowed, false, JSON.stringify(decision));
      strictEqual(log.notMine.length, 0, 'разрушающую перезапись обязан отклонить оператор, а не гейт сам');
      strictEqual(log.approvals.length, 1);
      strictEqual(log.approvals[0]?.outcome, 'denied');
      ok(/destructiveOverwrite/.test(log.approvals[0]?.why ?? ''), JSON.stringify(log.approvals[0]));

      handle.detach();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('запись в denyWritesTo получает отказ, обычная запись — согласие', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-bench-op-'));
    try {
      const bus = new ApprovalBus();
      const script = readHumanScript(HUMAN_JSON);
      const log = emptyOperatorLog();
      const runId = 'r3';
      const handle = attachOperator({ gate: bus, askGate: new AskBus(), runId: () => runId, script, log });
      const ctx = baseCtx(root);

      const deniedCall: NormalizedCall = { kind: 'write', path: 'src/discounts.ts', content: 'x\n' };
      const deniedDecision = await bus.gate.request({
        runId,
        stage: 'chunk',
        requestId: requestId(),
        toolName: 'Write',
        rawInput: { path: 'src/discounts.ts', content: 'x\n' },
        call: deniedCall,
        ctx,
      });
      strictEqual(deniedDecision.allowed, false, JSON.stringify(deniedDecision));

      const allowedCall: NormalizedCall = { kind: 'write', path: 'src/oversize.ts', content: 'x\n' };
      const allowedDecision = await bus.gate.request({
        runId,
        stage: 'chunk',
        requestId: requestId(),
        toolName: 'Write',
        rawInput: { path: 'src/oversize.ts', content: 'x\n' },
        call: allowedCall,
        ctx,
      });
      strictEqual(allowedDecision.allowed, true, JSON.stringify(allowedDecision));

      strictEqual(log.approvals.length, 2);
      strictEqual(log.approvals[0]?.outcome, 'denied');
      strictEqual(log.approvals[1]?.outcome, 'granted');

      handle.detach();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('denyWritesTo срабатывает и на абсолютном пути с обратными слэшами (flow sdk на Windows)', async () => {
    // Претендент приходит с `D:\…\src\discounts.ts`, а банк говорит `src/discounts.ts`:
    // подстрочное сравнение без приведения разделителей пропускало запись «default → allow».
    const root = mkdtempSync(join(tmpdir(), 'sdlc-bench-op-'));
    try {
      const bus = new ApprovalBus();
      const script = readHumanScript(HUMAN_JSON);
      const log = emptyOperatorLog();
      const runId = 'r3w';
      const handle = attachOperator({ gate: bus, askGate: new AskBus(), runId: () => runId, script, log });
      const ctx = baseCtx(root);
      const winPath = `${root.replace(/\//g, '\\')}\\src\\discounts.ts`;
      const decision = await bus.gate.request({
        runId,
        stage: 'chunk',
        requestId: requestId(),
        toolName: 'Write',
        rawInput: { path: winPath, content: 'x\n' },
        call: { kind: 'write', path: winPath, content: 'x\n' },
        ctx,
      });
      strictEqual(decision.allowed, false, JSON.stringify(decision));
      handle.detach();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('bankRegExp: \\w в регулярке банка берёт кириллицу, экранированный \\\\w не трогается', () => {
    // `\w` в JS — ASCII даже под флагом u; шаблоны банков написаны по-русски и без подмены
    // не совпадали ни с одной русской формой (28 файлов).
    ok(bankRegExp('как\\s+запуск\\w*\\s+тест').test('Как запускать тесты?'));
    ok(bankRegExp('обязател\\w*\\s+ли').test('Обязателен ли параметр issuer?'));
    ok(bankRegExp('дальн\\w*\\s+зон').test('что с дальней зоной?'));
    strictEqual(bankRegExp('строк\\w+').test('строк'), false, '\\w+ требует хотя бы один символ');
    ok(bankRegExp('a\\\\w').test('a\\w'), 'литеральный обратный слэш перед w — не класс');
  });

  it('AskHuman отвечает из банка: развилка получает настоящий ответ', async () => {
    const askBus = new AskBus();
    const script = readHumanScript(HUMAN_JSON);
    const log = emptyOperatorLog();
    const runId = 'r4';
    const handle = attachOperator({ gate: new ApprovalBus(), askGate: askBus, runId: () => runId, script, log });

    const q: Question = {
      id: 'q1',
      question: 'Какая ставка надбавки за негабарит для отправлений с суммой измерений свыше 300 см?',
      header: 'Ставка негабарита',
      multiSelect: false,
      options: [],
    };
    const answers = await askBus.gate.ask({ runId, stage: 'ask', questions: [q] });

    ok(answers['q1']?.[0]?.includes('90%'), JSON.stringify(answers));
    strictEqual(log.asks.length, 1);
    strictEqual(log.asks[0]?.answeredFrom, 'rule');
    strictEqual(log.asks[0]?.tag, 'fork.rate');

    handle.detach();
  });

  it('вопрос без совпадения уходит в fallback', async () => {
    const askBus = new AskBus();
    const script = readHumanScript(HUMAN_JSON);
    const log = emptyOperatorLog();
    const runId = 'r5';
    const handle = attachOperator({ gate: new ApprovalBus(), askGate: askBus, runId: () => runId, script, log });

    const q: Question = {
      id: 'q1',
      question: 'Какой любимый цвет у заказчика?',
      header: 'Не по теме',
      multiSelect: false,
      options: [],
    };
    const answers = await askBus.gate.ask({ runId, stage: 'ask', questions: [q] });

    deepStrictEqual(answers['q1'], script.answers.fallback);
    strictEqual(log.asks[0]?.answeredFrom, 'fallback');

    handle.detach();
  });
});
