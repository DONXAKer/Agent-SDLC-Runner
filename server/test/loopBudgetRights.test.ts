/**
 * Бюджет и права во флоу `loop`.
 *
 * Оба инварианта здесь — про то, что нельзя проверить чтением кода одного файла:
 *
 * - **Бюджет ОБЩИЙ.** Каждый маршрут ансамбля и каждый вложенный субагент раньше получал
 *   полный `maxBudgetUsd` проекта и сверял его со СВОИМ локальным счётчиком, так что
 *   объявленный потолок витка молча умножался на число прогонов.
 * - **Права вызывающего доезжают до политики.** Пересечение прав этапа с объявленными
 *   правами субагента раньше доходило только до списка инструментов, который показывают
 *   модели, — то есть держалось на её послушании, а не на гейте.
 */

import { ok, strictEqual } from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import type { NormalizedCall, ToolName } from '@sdlc-runner/shared';

import { LoopExecutor } from '../src/exec/LoopExecutor.ts';
import type { ChatProvider } from '../src/provider/ChatProvider.ts';
import type { ExecHooks, ExecRequest, SubagentDef } from '../src/exec/StageExecutor.ts';

// `hooks()` мокает `onToolRequest` и всегда отвечает `allowed: true` — значит `LoopExecutor`
// реально доходит до `executeTool`, и тестовый `write()` (`file_path: 'a.ts'`) РЕАЛЬНО
// пишет файл на диск относительно `request().cwd`. `process.cwd()` там раньше означал
// «текущий рабочий каталог процесса тестов» — то есть `server/`, откуда обычно запускают
// `npm test`, — и тест молча оставлял мусорный `server/a.ts` при каждом прогоне. Изолируем
// в tmpdir, чтобы тест не писал в сам репозиторий.
const scratchDir = mkdtempSync(join(tmpdir(), 'sdlc-loopbudget-'));
after(() => rmSync(scratchDir, { recursive: true, force: true }));

/** Провайдер-заглушка: ходы по порядку, цена хода задаётся отдельно. */
function provider(
  turns: { text: string; toolCalls?: { id: string; name: string; arguments: Record<string, unknown> }[] }[],
  costPerTurn = 0,
): ChatProvider {
  let i = 0;
  return {
    async chat() {
      const t = turns[Math.min(i++, turns.length - 1)];
      return {
        text: t?.text ?? '',
        toolCalls: (t?.toolCalls ?? []).map((c) => ({
          id: c.id,
          name: c.name,
          arguments: c.arguments,
          rawArguments: JSON.stringify(c.arguments),
        })),
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: costPerTurn,
          durationMs: 1, envBlocked: false
        },
        finishReason: 'end_turn' as const,
      };
    },
  } as unknown as ChatProvider;
}

interface Seen {
  /** Права вызывающего, с которыми пришёл каждый запрос на одобрение. */
  callerTools: ToolName[][];
  calls: NormalizedCall[];
  warns: string[];
}

function hooks(seen: Seen, allow = true): ExecHooks {
  return {
    onText: () => {},
    onThinking: () => {},
    onToolRequest: async (call: NormalizedCall, meta: { callerTools: readonly ToolName[] }) => {
      seen.calls.push(call);
      seen.callerTools.push([...meta.callerTools]);
      return allow
        ? { allowed: true, updatedInput: null, by: 'policy' as const }
        : { allowed: false, reason: 'политика запретила', by: 'policy' as const };
    },
    onToolResult: () => {},
    onAskHuman: async () => ({}),
    onUsage: () => {},
    onWarn: (m: string) => seen.warns.push(m),
    onFriction: () => {},
  } as unknown as ExecHooks;
}

function exec(
  turns: Parameters<typeof provider>[0],
  costPerTurn = 0,
): LoopExecutor {
  return new LoopExecutor({
    provider: provider(turns, costPerTurn),
    maxResultBytes: 1000,
    readRangeRequiredAboveBytes: 1000,
    bashTimeoutMs: 1000,
    temperature: null,
  });
}

const locator: SubagentDef = {
  name: 'sdlc-locator',
  description: 'разведчик места правки',
  prompt: 'ТЫ РАЗВЕДЧИК',
  // Права записи не объявлены — это и есть та планка, которую держит пересечение.
  tools: ['Read', 'Grep'],
  model: null,
};

/** Субагент без строки `tools:` в файле: наследует права вызывающего. */
const inherits: SubagentDef = {
  name: 'sdlc-reviewer',
  description: 'рецензент',
  prompt: 'ТЫ РЕЦЕНЗЕНТ',
  tools: null,
  model: null,
};

/** Субагент, у которого объявлено пусто: инструментов действительно нет. */
const nothing: SubagentDef = { ...inherits, name: 'пустой', tools: [] };

function request(over: Partial<ExecRequest> = {}): ExecRequest {
  return {
    prompt: { presetNote: null, system: 'этап', user: 'работай', tools: [], editedByOperator: false },
    cwd: scratchDir,
    model: 'm',
    allowedTools: ['Read', 'Grep', 'Write', 'Task'] as ToolName[],
  mcp: null,
  finishGuard: null,
  salvageFromText: null,
    readOnlyDirs: [],
    subagents: [locator, inherits, nothing],
    maxTurns: 8,
    maxBudgetUsd: null,
    signal: new AbortController().signal,
    ...over,
  } as ExecRequest;
}

const task = (agent: string, id = 't1') => ({
  id,
  name: 'Task',
  arguments: { subagent_type: agent, prompt: 'посмотри' },
});

const read = (id = 'r1') => ({ id, name: 'Read', arguments: { file_path: 'README.md' } });
const write = (id = 'w1') => ({ id, name: 'Write', arguments: { file_path: 'a.ts', content: 'x' } });

describe('бюджет витка общий на все прогоны', () => {
  it('уже потраченное вне этого вызова учитывается', async () => {
    const seen: Seen = { callerTools: [], calls: [], warns: [] };
    // Ход стоит $0.30, потолок $1.00, но вне этого вызова уже потрачено $0.90 —
    // прогон обязан упереться в бюджет на первом же ходе.
    const r = await exec([{ text: 'работаю' }], 0.3).run(
      request({ maxBudgetUsd: 1, spentUsdBefore: 0.9 }),
      hooks(seen),
    );
    strictEqual(r.ok, false);
    ok(r.note?.includes('бюджет прогона исчерпан'), r.note);
  });

  it('без потраченного ранее тот же ход в бюджет укладывается', async () => {
    const seen: Seen = { callerTools: [], calls: [], warns: [] };
    const r = await exec([{ text: 'работаю' }], 0.3).run(
      request({ maxBudgetUsd: 1, spentUsdBefore: 0 }),
      hooks(seen),
    );
    strictEqual(r.ok, true);
  });

  it('вложенный субагент делит потолок с родителем, а не получает свой', async () => {
    const seen: Seen = { callerTools: [], calls: [], warns: [] };
    // Родитель тратит $0.60 на ходе с вызовом субагента; субагент со своим полным
    // потолком отработал бы ещё на $0.60 и уложился бы в «$1.00». С общим счётом он
    // обязан упереться — и его провал доходит до родителя ошибкой инструмента.
    const r = await exec(
      [{ text: '', toolCalls: [task('sdlc-reviewer')] }, { text: 'готово' }],
      0.6,
    ).run(request({ maxBudgetUsd: 1 }), hooks(seen));
    ok(
      seen.warns.some((w) => w.includes('бюджет прогона исчерпан')),
      `субагент не упёрся в общий бюджет: ${seen.warns.join(' | ')}`,
    );
    ok(r !== undefined);
  });
});

describe('права вызывающего доезжают до политики', () => {
  it('на верхнем уровне это права этапа', async () => {
    const seen: Seen = { callerTools: [], calls: [], warns: [] };
    await exec([{ text: '', toolCalls: [read()] }, { text: 'готово' }]).run(request(), hooks(seen));
    strictEqual(seen.callerTools.length, 1);
    ok(seen.callerTools[0]?.includes('Write'), 'права этапа урезаны на пустом месте');
  });

  it('внутри субагента — пересечение, и Write туда не попадает', async () => {
    const seen: Seen = { callerTools: [], calls: [], warns: [] };
    // Этап умеет `Write`, разведчик его не объявлял. Модель субагента всё равно зовёт
    // `Write` — гейт обязан увидеть СУЖЕННЫЕ права, иначе запись пройдёт по правам этапа.
    await exec([
      { text: '', toolCalls: [task('sdlc-locator')] },
      { text: '', toolCalls: [write()] },
      { text: 'готово' },
    ]).run(request(), hooks(seen));

    const nested = seen.callerTools[seen.callerTools.length - 1];
    ok(nested !== undefined, 'вложенный вызов до гейта не дошёл');
    strictEqual(nested.includes('Write'), false, `Write протёк в права субагента: ${nested.join(', ')}`);
    ok(nested.includes('Read'), 'объявленные права субагента потерялись');
  });

  it('субагент без строки tools наследует права этапа', async () => {
    const seen: Seen = { callerTools: [], calls: [], warns: [] };
    await exec([
      { text: '', toolCalls: [task('sdlc-reviewer')] },
      { text: '', toolCalls: [read('r2')] },
      { text: 'готово' },
    ]).run(request(), hooks(seen));

    const nested = seen.callerTools[seen.callerTools.length - 1];
    ok(nested?.includes('Write'), 'наследование прав этапа не сработало');
  });

  it('пустое пересечение — отказ, а не прогон вслепую', async () => {
    const seen: Seen = { callerTools: [], calls: [], warns: [] };
    // Прогон без единого инструмента ревьюером не является: раньше он завершался
    // «успешно» и зажигал гейт «Ревью независимым агентом» отчётом, сочинённым вслепую.
    await exec([{ text: '', toolCalls: [task('пустой')] }, { text: 'готово' }]).run(
      request(),
      hooks(seen),
    );
    ok(
      seen.warns.some((w) => w.includes('ни одного инструмента')),
      `нет отказа по пустым правам: ${seen.warns.join(' | ')}`,
    );
  });
});

describe('детект залипания в параллельной ветке', () => {
  it('повторённый ход из субагентов обрывает цикл, а не крутится до maxTurns', async () => {
    const seen: Seen = { callerTools: [], calls: [], warns: [] };
    // Один и тот же ход из ДВУХ вызовов Task подряд. Пока `repeats` здесь обнулялся
    // безусловно, цикл шёл до `maxTurns`, и каждый ход стоил двух вложенных прогонов.
    const turn = {
      text: '',
      toolCalls: [task('sdlc-locator', 'a'), task('sdlc-reviewer', 'b')],
    };
    const r = await exec([turn, turn, turn, turn, turn, turn]).run(
      request({ maxTurns: 20 }),
      hooks(seen),
    );
    strictEqual(r.ok, false);
    ok(r.note?.includes('прогресса нет'), r.note);
  });
});
