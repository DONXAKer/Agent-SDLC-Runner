/**
 * Чистая логика компактного режима: группировка ленты, очередь решений, сводки, разбор
 * патча по файлам, персистентность предпочтений.
 *
 * Компоненты по-прежнему не рендерятся — раннера React в проекте нет; проверяется слой,
 * вынесенный из компонентов ровно для того, чтобы быть проверяемым.
 */

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { RunDetail, RunEvent } from '@sdlc-runner/shared';

import { splitPatchByFile, orderFiles } from '../src/lib/diffStats.ts';
import { groupEvents } from '../src/lib/eventGroups.ts';
import { mergePending } from '../src/lib/pending.ts';
import { readLS, writeLS } from '../src/lib/persist.ts';
import { gateSummary, promptSummary } from '../src/lib/summaries.ts';
import { PANEL_TONE, diffLineTone, verdictTone } from '../src/lib/tones.ts';

// ---------------------------------------------------------------------------
// Конструкторы событий: тесту важны type/requestId/статусы, остальное — заглушки.
// ---------------------------------------------------------------------------

function req(requestId: string, over: Record<string, unknown> = {}): RunEvent {
  return {
    type: 'tool_request',
    runId: 'r',
    stage: 'chunk',
    requestId,
    toolName: 'Write',
    rawInput: {},
    call: { kind: 'write', path: 'a.ts', content: '' },
    policy: { ok: true },
    preview: null,
    writeTargets: null,
    ...over,
  } as unknown as RunEvent;
}

function resolved(requestId: string, allowed: boolean): RunEvent {
  return {
    type: 'tool_resolved',
    runId: 'r',
    stage: 'chunk',
    requestId,
    decision: allowed ? { allowed: true, updatedInput: null, by: 'operator' } : { allowed: false, reason: 'нет', by: 'operator' },
  } as unknown as RunEvent;
}

function result(requestId: string, okFlag: boolean): RunEvent {
  return {
    type: 'tool_result',
    runId: 'r',
    stage: 'chunk',
    requestId,
    ok: okFlag,
    summary: 'итог',
    durationMs: 5,
  } as unknown as RunEvent;
}

const text: RunEvent = { type: 'assistant_text', runId: 'r', stage: 'chunk', text: 'привет' } as RunEvent;

describe('группировка троек вызова инструмента', () => {
  it('тройка схлопывается в один элемент со статусом ok', () => {
    const items = groupEvents([text, req('a'), resolved('a', true), result('a', true)]);
    strictEqual(items.length, 2);
    strictEqual(items[0]?.kind, 'plain');
    const g = items[1];
    if (g?.kind !== 'tool') throw new Error('ожидалась группа');
    strictEqual(g.status, 'ok');
    ok(g.resolved !== undefined && g.result !== undefined);
  });

  it('запрос без решения остаётся pending — «ждёт решения» не сворачивается в нейтральное', () => {
    const items = groupEvents([req('a')]);
    const g = items[0];
    if (g?.kind !== 'tool') throw new Error('ожидалась группа');
    strictEqual(g.status, 'pending');
  });

  it('разрешённый без результата — running, отклонённый — denied, провал — failed', () => {
    const running = groupEvents([req('a'), resolved('a', true)])[0];
    const denied = groupEvents([req('b'), resolved('b', false)])[0];
    const failed = groupEvents([req('c'), resolved('c', true), result('c', false)])[0];
    if (running?.kind !== 'tool' || denied?.kind !== 'tool' || failed?.kind !== 'tool') {
      throw new Error('ожидались группы');
    }
    strictEqual(running.status, 'running');
    strictEqual(denied.status, 'denied');
    strictEqual(failed.status, 'failed');
  });

  it('осиротевшие resolved/result без своего request не теряются', () => {
    // Буфер шины вытесняет с начала: request мог уйти, а решение и результат остаться.
    const items = groupEvents([resolved('gone', true), result('gone', true)]);
    strictEqual(items.length, 2);
    ok(items.every((i) => i.kind === 'plain'));
  });

  it('порядок сохраняется: группа встаёт на позицию запроса', () => {
    const items = groupEvents([req('a'), text, resolved('a', true), result('a', true)]);
    strictEqual(items.length, 2);
    strictEqual(items[0]?.kind, 'tool');
    strictEqual(items[1]?.kind, 'plain');
  });
});

describe('очередь решений mergePending', () => {
  const detailWith = (over: Partial<RunDetail>): RunDetail =>
    ({ pendingApprovals: [], pendingQuestions: [], ...over }) as unknown as RunDetail;

  it('дубль из detail и ленты не двоится', () => {
    const detail = detailWith({
      pendingApprovals: [
        { requestId: 'a', rawInput: {}, call: { kind: 'write', path: 'a.ts' }, policy: { ok: true }, preview: null },
      ] as unknown as RunDetail['pendingApprovals'],
    });
    const { approvals } = mergePending(detail, [req('a')]);
    strictEqual(approvals.length, 1);
  });

  it('tool_resolved убирает одобрение, даже если сервер его ещё перечисляет', () => {
    const detail = detailWith({
      pendingApprovals: [
        { requestId: 'a', rawInput: {}, call: { kind: 'write', path: 'a.ts' }, policy: { ok: true }, preview: null },
      ] as unknown as RunDetail['pendingApprovals'],
    });
    const { approvals } = mergePending(detail, [req('a'), resolved('a', true)]);
    strictEqual(approvals.length, 0);
  });

  it('свежий запрос из ленты попадает в очередь и без detail', () => {
    const { approvals } = mergePending(null, [req('a')]);
    strictEqual(approvals.length, 1);
    strictEqual(approvals[0]?.requestId, 'a');
  });

  it('вопрос агента закрывается по tool_result, а не по tool_resolved', () => {
    const ask = req('q', { call: { kind: 'ask_human', questions: [] } });
    strictEqual(mergePending(null, [ask]).asks.length, 1);
    strictEqual(mergePending(null, [ask, result('q', true)]).asks.length, 0);
  });
});

describe('сводки', () => {
  it('несобранный промпт называется прямо', () => {
    strictEqual(promptSummary(null, false), 'промпт не собран');
  });

  it('оценка токенов помечена как приблизительная, правка — отдельно', () => {
    const prompt = {
      presetNote: null,
      system: 'x'.repeat(4000),
      user: 'y'.repeat(4000),
      tools: [],
      editedByOperator: false,
    };
    const plain = promptSummary(prompt, false);
    ok(plain.includes('~'), 'оценка без «~» обещает точность, которой нет');
    ok(plain.includes('2.0K'), plain);
    ok(!plain.includes('изменён'), 'правки не было');
    ok(promptSummary(prompt, true).includes('изменён вручную'));
  });

  it('счётчики гейтов покрывают все статусы и сходятся с длиной входа', () => {
    const results = [
      { name: 'a', status: '✅', command: null, exitCode: null, lastLine: '', durationMs: 0 },
      { name: 'b', status: '❌', command: null, exitCode: 1, lastLine: '', durationMs: 0 },
      { name: 'c', status: '⏭', command: null, exitCode: null, lastLine: '', durationMs: 0 },
      { name: 'd', status: '✅', command: null, exitCode: 0, lastLine: '', durationMs: 0 },
    ] as const;
    const counts = gateSummary([...results]);
    strictEqual(
      counts.reduce((s, c) => s + c.n, 0),
      results.length,
      'сумма счётчиков разошлась со «всего» — какой-то статус выпал',
    );
    deepStrictEqual(
      Object.fromEntries(counts.map((c) => [c.status, c.n])),
      { '✅': 2, '❌': 1, '⏭': 1 },
    );
  });
});

describe('разбор патча по файлам', () => {
  const patch = [
    'diff --git a/src/a.ts b/src/a.ts',
    'index 111..222 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,2 +1,2 @@',
    '-старое',
    '+новое',
    '+ещё строка',
    'diff --git a/with space.md b/with space.md',
    '--- a/with space.md',
    '+++ b/with space.md',
    '@@ -1 +1 @@',
    '-x',
    '+y',
  ].join('\n');

  it('файлы режутся по заголовкам, +/− считаются без +++/---', () => {
    const files = splitPatchByFile(patch);
    strictEqual(files.length, 2);
    strictEqual(files[0]?.path, 'src/a.ts');
    strictEqual(files[0]?.adds, 2);
    strictEqual(files[0]?.dels, 1);
    // Путь с пробелом: git не квотит пробелы в заголовке, ленивая a-сторона обязана
    // отрезаться по первому « b/».
    strictEqual(files[1]?.path, 'with space.md');
    strictEqual(files[1]?.adds, 1);
    ok(files[0]!.text.startsWith('diff --git'), 'текст файла включает заголовок');
  });

  it('квотированный путь берётся из b/-стороны без кавычек', () => {
    const files = splitPatchByFile('diff --git "a/п.md" "b/п.md"\n--- "a/п.md"\n+++ "b/п.md"\n+z');
    strictEqual(files[0]?.path, 'п.md');
    strictEqual(files[0]?.adds, 1);
  });

  it('пустой патч — пустой список', () => {
    deepStrictEqual(splitPatchByFile(''), []);
  });

  it('orderFiles поднимает файлы вне плана наверх, незнакомые считает вне плана', () => {
    const parsed = splitPatchByFile(patch);
    const ordered = orderFiles(parsed, [{ path: 'src/a.ts', inPlan: true }]);
    strictEqual(ordered.length, 2);
    // «with space.md» сервер не перечислил — по худшему случаю он вне плана и первый.
    strictEqual(ordered[0]?.path, 'with space.md');
    strictEqual(ordered[0]?.inPlan, false);
    strictEqual(ordered[1]?.inPlan, true);
  });
});

describe('персистентность предпочтений', () => {
  it('бросающий localStorage не роняет страницу — чтение отдаёт null, запись молчит', () => {
    const orig = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem() {
          throw new Error('приватный режим');
        },
        setItem() {
          throw new Error('приватный режим');
        },
      },
    });
    try {
      strictEqual(readLS('viewMode'), null);
      writeLS('viewMode', 'compact');
    } finally {
      if (orig === undefined) delete (globalThis as Record<string, unknown>)['localStorage'];
      else Object.defineProperty(globalThis, 'localStorage', orig);
    }
  });

  it('ключи пишутся с неймспейсом sdlc.web.', () => {
    const store = new Map<string, string>();
    const orig = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
      },
    });
    try {
      writeLS('viewMode', 'compact');
      ok(store.has('sdlc.web.viewMode'), [...store.keys()].join(', '));
      strictEqual(readLS('viewMode'), 'compact');
    } finally {
      if (orig === undefined) delete (globalThis as Record<string, unknown>)['localStorage'];
      else Object.defineProperty(globalThis, 'localStorage', orig);
    }
  });
});

describe('общие тона', () => {
  it('панельные тона различимы между собой', () => {
    const tones = Object.values(PANEL_TONE);
    strictEqual(new Set(tones).size, tones.length, 'два статуса панели красятся одинаково');
  });

  it('вердикт красится из той же карты, что и панели', () => {
    strictEqual(verdictTone(true), PANEL_TONE.ok);
    strictEqual(verdictTone(false), PANEL_TONE.fail);
  });

  it('заголовки diff не красятся как изменённые строки', () => {
    strictEqual(diffLineTone('+добавлено'), 'text-emerald-400');
    strictEqual(diffLineTone('-удалено'), 'text-red-400');
    ok(diffLineTone('+++ b/a.ts') !== 'text-emerald-400');
    ok(diffLineTone('--- a/a.ts') !== 'text-red-400');
    strictEqual(diffLineTone('@@ -1 +1 @@'), 'text-sky-400');
  });
});
