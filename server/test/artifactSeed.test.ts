/**
 * Скелет артефакта и проверка «ход завершён ≠ работа сделана».
 *
 * Обе конструкции заведены по измерению, а не по вкусу: на живом прогоне пять локальных
 * моделей подряд дошли до чтения формы и объявили ход законченным, не записав ни одного
 * артефакта, — и этап при этом считался пройденным.
 */

import { ok, strictEqual } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import type { Decision, PreparedPrompt } from '@sdlc-runner/shared';
import { emptyUsage } from '@sdlc-runner/shared';

import { LoopExecutor } from '../src/exec/LoopExecutor.ts';
import type { ExecHooks, ExecRequest } from '../src/exec/StageExecutor.ts';
import type { ChatProvider, ChatRequest, ChatTurn } from '../src/provider/ChatProvider.ts';
import { missingNow, seedArtifacts, stillMissing, templateNameFor } from '../src/run/seed.ts';

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** Эталон методологии с формами и пустой каталог витка рядом. */
function world(): { methodology: string; witok: string } {
  const root = mkdtempSync(join(tmpdir(), 'sdlc-seed-'));
  dirs.push(root);
  const methodology = join(root, 'methodology');
  const witok = join(root, 'project', '.sdlc', 'demo');
  mkdirSync(join(methodology, 'templates'), { recursive: true });
  mkdirSync(witok, { recursive: true });
  writeFileSync(
    join(methodology, 'templates', 'intent.template.md'),
    '# Задача: ‹название витка›\n',
    'utf8',
  );
  writeFileSync(join(methodology, 'templates', 'gates.template.md'), '# Набор гейтов\n', 'utf8');
  return { methodology, witok };
}

describe('имя формы по имени артефакта', () => {
  it('обычный артефакт — форма один в один', () => {
    strictEqual(templateNameFor('D:/x/.sdlc/demo/intent.md'), 'intent.template.md');
  });

  it('номера chunk и попытки в имени формы не участвуют', () => {
    // Форма одна на класс артефактов: `chunk-7-journal.md` и `chunk-1-journal.md` —
    // один и тот же бланк.
    strictEqual(templateNameFor('/x/chunk-7-journal.md'), 'chunk-journal.template.md');
    strictEqual(
      templateNameFor('/x/verification-report-2-attempt-3.md'),
      'verification-report.template.md',
    );
  });
});

describe('раскладка форм до этапа', () => {
  it('отсутствующий артефакт получает бланк', () => {
    const { methodology, witok } = world();
    const intent = join(witok, 'intent.md');

    const seeded = seedArtifacts([intent], methodology);
    strictEqual(seeded.length, 1);
    ok(readFileSync(intent, 'utf8').includes('‹название витка›'));
  });

  it('существующий артефакт не затирается', () => {
    // Файл на месте — это работа человека или прошлого этапа. Положить поверх бланк
    // значит стереть уже принятое решение.
    const { methodology, witok } = world();
    const intent = join(witok, 'intent.md');
    writeFileSync(intent, 'моя работа', 'utf8');

    strictEqual(seedArtifacts([intent], methodology).length, 0);
    strictEqual(readFileSync(intent, 'utf8'), 'моя работа');
  });

  it('формы нет — это не ошибка, просто ничего не раскладываем', () => {
    const { methodology, witok } = world();
    strictEqual(seedArtifacts([join(witok, 'чего-то-нет.md')], methodology).length, 0);
  });

  it('«не появилось» считается от состояния ДО этапа', () => {
    // У этапа 1 в списке производимого есть набор гейтов проекта, который обычно
    // существует задолго до витка: считать его доказательством работы этапа нельзя.
    const { witok } = world();
    const gates = join(witok, 'gates.md');
    const intent = join(witok, 'intent.md');
    writeFileSync(gates, '# уже был', 'utf8');

    const before = missingNow([gates, intent]);
    strictEqual(before.join(), intent);

    // Этап ничего не записал: недостающим остаётся intent, а не «оба на месте».
    strictEqual(stillMissing([gates, intent], before).join(), intent);

    writeFileSync(intent, '# записан', 'utf8');
    strictEqual(stillMissing([gates, intent], before).length, 0);
  });
});

// ---------------------------------------------------------------------------

const PROMPT: PreparedPrompt = {
  presetNote: null,
  system: 'системный блок',
  user: 'задача',
  tools: [],
  editedByOperator: false,
};

function request(guard: (() => string | null) | null): ExecRequest {
  return {
    prompt: PROMPT,
    cwd: process.cwd(),
    model: 'test-model',
    allowedTools: ['Read'],
    mcp: null,
    finishGuard: guard,
    readOnlyDirs: [],
    subagents: [],
    maxTurns: 8,
    maxBudgetUsd: null,
    signal: new AbortController().signal,
  };
}

function hooks(): ExecHooks & { warns: string[] } {
  const warns: string[] = [];
  return Object.assign(
    {
      onText: () => {},
      onThinking: () => {},
      onToolRequest: () =>
        Promise.resolve<Decision>({ allowed: true, updatedInput: null, by: 'auto' }),
      onToolResult: () => {},
      onAskHuman: () => Promise.resolve({}),
      onUsage: () => {},
      onWarn: (m: string) => {
        warns.push(m);
      },
      onFriction: () => {},
    } satisfies ExecHooks,
    { warns },
  );
}

function provider(): ChatProvider & { calls: number } {
  const state = { calls: 0 };
  return {
    name: 'fake',
    get calls() {
      return state.calls;
    },
    chat(_req: ChatRequest): Promise<ChatTurn> {
      state.calls++;
      return Promise.resolve({
        text: 'готово',
        toolCalls: [],
        finishReason: 'end_turn',
        usage: emptyUsage(),
      });
    },
  } as ChatProvider & { calls: number };
}

const executor = (p: ChatProvider): LoopExecutor =>
  new LoopExecutor({
    provider: p,
    maxResultBytes: 5_000,
    readRangeRequiredAboveBytes: 1_000_000,
    bashTimeoutMs: 30_000,
    temperature: null,
  });

describe('«ход завершён» не принимается без артефакта', () => {
  it('модель получает замечание и ещё один шанс', async () => {
    const p = provider();
    const h = hooks();
    let asked = 0;
    // Первые два раза артефакта нет, на третий — появился.
    const guard = (): string | null => (++asked >= 3 ? null : 'артефакт этапа не записан: intent.md');

    const r = await executor(p).run(request(guard), h);
    strictEqual(r.ok, true, 'после того как артефакт появился, этап проходит');
    strictEqual(p.calls, 3, 'два напоминания — два дополнительных хода');
    ok(h.warns.some((w) => w.includes('напоминание 1 из 2')));
  });

  it('после двух напоминаний этап признаётся неудавшимся, а не пройденным', async () => {
    const p = provider();
    const r = await executor(p).run(
      request(() => 'артефакт этапа не записан: intent.md'),
      hooks(),
    );
    strictEqual(r.ok, false);
    ok(r.note.includes('intent.md'), 'в причине названо, чего именно нет');
  });

  it('без стража поведение прежнее', async () => {
    const p = provider();
    const r = await executor(p).run(request(null), hooks());
    strictEqual(r.ok, true);
    strictEqual(p.calls, 1);
  });
});
