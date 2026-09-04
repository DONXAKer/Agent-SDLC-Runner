/**
 * FinalizeArtifact во флоу `loop`: заявка «готово» по шаблону с плейсхолдерами
 * отклоняется инструментом, а не просьбой в промпте.
 *
 * Наблюдалось на живом витке: слабая модель трижды подряд финализировала нетронутый
 * журнал chunk'а — и этап уходил `done` при пустом артефакте. Проверку заполненности
 * делал только вход СЛЕДУЮЩЕГО этапа, то есть ложный зелёный жил до чужого предусловия.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ok } from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { NormalizedCall, ToolName } from '@sdlc-runner/shared';

import { LoopExecutor } from '../src/exec/LoopExecutor.ts';
import type { ChatProvider } from '../src/provider/ChatProvider.ts';
import type { ExecHooks, ExecRequest } from '../src/exec/StageExecutor.ts';

function provider(
  turns: { text: string; toolCalls?: { id: string; name: string; arguments: Record<string, unknown> }[] }[],
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
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, durationMs: 1, envBlocked: false },
        finishReason: 'end_turn' as const,
      };
    },
  } as unknown as ChatProvider;
}

interface Seen {
  results: { ok: boolean; summary: string }[];
}

function hooks(seen: Seen): ExecHooks {
  return {
    onText: () => {},
    onThinking: () => {},
    onToolRequest: async (_call: NormalizedCall) => ({ allowed: true, updatedInput: null, by: 'policy' as const }),
    onToolResult: (r: { ok: boolean; summary: string }) => seen.results.push(r),
    onAskHuman: async () => ({}),
    onRecord: () => 'записано',
    onUsage: () => {},
    onWarn: () => {},
    onFriction: () => {},
  } as unknown as ExecHooks;
}

function request(cwd: string, over: Partial<ExecRequest> = {}): ExecRequest {
  return {
    prompt: { presetNote: null, system: 'этап', user: 'работай', tools: [], editedByOperator: false },
    cwd,
    model: 'm',
    allowedTools: ['Read', 'Edit', 'FinalizeArtifact'] as ToolName[],
    mcp: null,
    finishGuard: null,
    salvageFromText: null,
    readOnlyDirs: [],
    subagents: [],
    maxTurns: 4,
    maxBudgetUsd: null,
    signal: new AbortController().signal,
    ...over,
  } as ExecRequest;
}

const editCall = (id: string, file: string, oldString: string, newString: string) => ({
  id,
  name: 'Edit',
  arguments: { file_path: file, old_string: oldString, new_string: newString },
});

function exec(turns: Parameters<typeof provider>[0]): LoopExecutor {
  return new LoopExecutor({
    provider: provider(turns),
    maxResultBytes: 1000,
    readRangeRequiredAboveBytes: 1000,
    bashTimeoutMs: 1000,
    temperature: null,
  });
}

const finalizeCall = (artifact: string) => ({
  id: 'f1',
  name: 'FinalizeArtifact',
  arguments: { artifact, note: 'готово' },
});

describe('FinalizeArtifact отклоняет пустой шаблон', () => {
  it('артефакт с плейсхолдерами не финализируется — модель получает замечание', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-fin-'));
    writeFileSync(join(root, 'journal.md'), '# Журнал\n\n- **База:** ‹base_sha›\n');
    const seen: Seen = { results: [] };
    await exec([{ text: '', toolCalls: [finalizeCall('journal.md')] }, { text: 'понял' }]).run(
      request(root),
      hooks(seen),
    );
    ok(
      seen.results.some((r) => r.summary.includes('незаполненных мест')),
      'нет замечания о плейсхолдерах',
    );
    ok(
      !seen.results.some((r) => r.summary.includes('заявлен готовым')),
      'пустой шаблон засчитан готовым',
    );
    // Локализация (finalizeCheck.ts): замечание называет поле, а не только число — иначе
    // модель заново сканирует весь документ и рискует переписать его целиком.
    ok(
      seen.results.some((r) => /база/i.test(r.summary)),
      'замечание не называет незаполненное поле по имени',
    );
  });

  it('несуществующий артефакт — замечание «сначала запиши»', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-fin-'));
    const seen: Seen = { results: [] };
    await exec([{ text: '', toolCalls: [finalizeCall('нет-такого.md')] }, { text: 'понял' }]).run(
      request(root),
      hooks(seen),
    );
    ok(seen.results.some((r) => r.summary.includes('не существует')), 'нет замечания об отсутствии');
  });

  it('заполненный артефакт финализируется; литеральный ‹…› в цитате формы не мешает', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-fin-'));
    writeFileSync(
      join(root, 'journal.md'),
      '# Журнал\n\n> Незаполненные места помечены `‹…›` — форма.\n\n- **База:** abc123\n',
    );
    const seen: Seen = { results: [] };
    await exec([{ text: '', toolCalls: [finalizeCall('journal.md')] }, { text: 'готово' }]).run(
      request(root),
      hooks(seen),
    );
    ok(seen.results.some((r) => r.summary.includes('заявлен готовым')), 'готовый артефакт не принят');
  });
});

describe('детектор застревания FinalizeArtifact (explore не убывает)', () => {
  it('число мест не убывает 3 отказа подряд — этап останавливается до maxTurns', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-fin-'));
    const artifact = join(root, 'exploration-report.md');
    writeFileSync(artifact, '# Отчёт\n\n- **Риски:** ‹риск›\n');
    const result = await exec([
      // Модель зовёт FinalizeArtifact трижды подряд, ничего в файле не меняя — ‹риск›
      // остаётся, отпечаток вызова каждый раз одинаков (`REPEAT_LIMIT` его бы поймал и
      // без этого детектора), но детектор застревания смотрит на СЧЁТ мест, а не на
      // отпечаток — проверяем именно его срабатывание, не REPEAT_LIMIT.
      { text: '', toolCalls: [finalizeCall('exploration-report.md')] },
      { text: '', toolCalls: [{ id: 'f2', name: 'FinalizeArtifact', arguments: { artifact: 'exploration-report.md', note: 'ещё раз' } }] },
      { text: '', toolCalls: [{ id: 'f3', name: 'FinalizeArtifact', arguments: { artifact: 'exploration-report.md', note: 'снова' } }] },
      { text: 'сдаюсь' },
    ]).run(request(root, { maxTurns: 10 }), hooks({ results: [] }));

    strictEqual(result.ok, false);
    ok(result.note.includes('зациклился на правке'), result.note);
    ok(result.note.includes('1 → 1 → 1'), result.note);
  });

  it('число мест убывает между отказами — детектор застревания НЕ срабатывает', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-fin-'));
    const artifact = join(root, 'exploration-report.md');
    writeFileSync(artifact, '# Отчёт\n\n- **A:** ‹a›\n- **B:** ‹b›\n- **C:** ‹c›\n- **D:** ‹d›\n');
    const result = await exec([
      // Каждый ход реально убирает одно место ПЕРЕД FinalizeArtifact — счёт убывает
      // 3 → 2 → 1 (три ПОДРЯД отказа, полное окно детектора), но монотонно вниз, а не
      // «не убывает» — срабатывать детектор не должен, хотя FinalizeArtifact вызван
      // трижды подряд и всякий раз отклонён (артефакт ещё не пуст).
      { text: '', toolCalls: [editCall('e1', artifact, '‹a›', 'значение A'), finalizeCall('exploration-report.md')] },
      { text: '', toolCalls: [editCall('e2', artifact, '‹b›', 'значение B'), finalizeCall('exploration-report.md')] },
      { text: '', toolCalls: [editCall('e3', artifact, '‹c›', 'значение C'), finalizeCall('exploration-report.md')] },
      { text: 'ещё не готово, продолжаю' },
    ]).run(request(root, { maxTurns: 10 }), hooks({ results: [] }));

    ok(!result.note.includes('зациклился'), result.note);
  });
});

// Хвост вывода для улики тестов: см. BuiltinOutcome.outputTail.
import { strictEqual } from 'node:assert/strict';
import { outputTailOf } from '../src/gates/builtin/index.ts';

describe('outputTailOf — хвост вывода для улики', () => {
  it('короткий вывод проходит целиком, stderr отделён', () => {
    const t = outputTailOf('a\nb', 'err');
    ok(t.includes('a\nb') && t.includes('--- stderr ---') && t.includes('err'));
  });

  it('длинный вывод режется по строкам с честной пометкой', () => {
    const long = Array.from({ length: 500 }, (_, i) => `line${i}`).join('\n');
    const t = outputTailOf(long, '', 200);
    ok(t.startsWith('[рантайм обрезал'));
    ok(t.includes('line499') && !t.includes('line100\n'));
  });

  it('пустой вывод — пустая строка, без пометок', () => {
    strictEqual(outputTailOf('', ''), '');
  });
});
