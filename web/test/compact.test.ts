/**
 * Чистая логика компактного режима: группировка ленты, очередь решений, сводки, разбор
 * патча по файлам, персистентность предпочтений.
 *
 * Компоненты по-прежнему не рендерятся — раннера React в проекте нет; проверяется слой,
 * вынесенный из компонентов ровно для того, чтобы быть проверяемым.
 */

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { PendingApproval, RunDetail, RunEvent } from '@sdlc-runner/shared';

import { orderFiles, splitPatchBlocks } from '../src/lib/diffStats.ts';
import { groupEvents, tailGroupedEvents } from '../src/lib/eventGroups.ts';
import { mergePending } from '../src/lib/pending.ts';
import { readLS, writeLS } from '../src/lib/persist.ts';
import { gateSummary } from '../src/lib/summaries.ts';
import { PANEL_TONE, diffLineTone, verdictTextTone, verdictTone } from '../src/lib/tones.ts';

// ---------------------------------------------------------------------------
// Конструкторы событий: типизированы честно, без `as unknown as` — рефакторинг формы
// события в shared обязан заваливать сборку теста, а не оставлять его молча зелёным.
// ---------------------------------------------------------------------------

type ToolRequestEvent = Extract<RunEvent, { type: 'tool_request' }>;
type ToolResolvedEvent = Extract<RunEvent, { type: 'tool_resolved' }>;
type ToolResultEvent = Extract<RunEvent, { type: 'tool_result' }>;

function req(requestId: string, over: Partial<ToolRequestEvent> = {}): ToolRequestEvent {
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
    destructive: null,
    createdAt: 0,
    ...over,
  };
}

function resolved(requestId: string, allowed: boolean): ToolResolvedEvent {
  return {
    type: 'tool_resolved',
    runId: 'r',
    stage: 'chunk',
    requestId,
    decision: allowed
      ? { allowed: true, updatedInput: null, by: 'operator' }
      : { allowed: false, reason: 'нет', by: 'operator' },
  };
}

function result(requestId: string, okFlag: boolean): ToolResultEvent {
  return {
    type: 'tool_result',
    runId: 'r',
    stage: 'chunk',
    requestId,
    ok: okFlag,
    summary: 'итог',
    durationMs: 5,
  };
}

function pendingApproval(requestId: string, over: Partial<PendingApproval> = {}): PendingApproval {
  return {
    runId: 'r',
    stage: 'chunk',
    requestId,
    toolName: 'Write',
    rawInput: {},
    call: { kind: 'write', path: 'a.ts', content: '' },
    policy: { ok: true },
    preview: null,
    writeTargets: null,
    destructive: null,
    createdAt: 0,
    ...over,
  };
}

const text: RunEvent = { type: 'assistant_text', runId: 'r', stage: 'chunk', text: 'привет' };

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

  it('отклонённый вызов остаётся denied и при синтетическом tool_result от loop-флоу', () => {
    // LoopExecutor эмитит tool_resolved(denied) И tool_result(ok:false) на один отказ —
    // исполнитель обязан вернуть модели хоть какой-то результат. `denied` не должен
    // проигрывать более позднему `result`.
    const items = groupEvents([req('d'), resolved('d', false), result('d', false)]);
    const g = items[0];
    if (g?.kind !== 'tool') throw new Error('ожидалась группа');
    strictEqual(g.status, 'denied');
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

describe('хвост ленты для живого прогресса', () => {
  it('режутся группы, а не сырые события: тройка не рассекается срезом', () => {
    // «Последние 2 события» от [text, req, resolved, result] дали бы огрызок тройки;
    // «последние 2 группы» — текст плюс тройку целиком.
    const tail = tailGroupedEvents([text, req('a'), resolved('a', true), result('a', true)], 2);
    strictEqual(tail.length, 4);
    strictEqual(tail[0]?.type, 'assistant_text');
    strictEqual(tail[1]?.type, 'tool_request');
    // Повторная группировка хвоста даёт те же строки — EventStream схлопнет тройку обратно.
    strictEqual(groupEvents(tail).length, 2);
  });

  it('хвост короче лимита возвращается целиком', () => {
    strictEqual(tailGroupedEvents([text], 8).length, 1);
  });

  it('группа стоит на позиции своего запроса, а не последнего события тройки', () => {
    // resolved/result пришли ПОСЛЕ text, но группа вызова считается за запросом —
    // последней строкой хвоста остаётся text, как и в полной ленте.
    const tail = tailGroupedEvents([req('a'), text, resolved('a', true), result('a', true)], 1);
    strictEqual(tail.length, 1);
    strictEqual(tail[0]?.type, 'assistant_text');
  });
});

describe('очередь решений mergePending', () => {
  const detailWith = (over: Partial<RunDetail>): RunDetail =>
    ({ pendingApprovals: [], pendingQuestions: [], ...over }) as unknown as RunDetail;

  it('дубль из detail и ленты не двоится', () => {
    const detail = detailWith({ pendingApprovals: [pendingApproval('a')] });
    const { approvals } = mergePending(detail, [req('a')]);
    strictEqual(approvals.length, 1);
  });

  it('tool_resolved убирает одобрение, даже если сервер его ещё перечисляет', () => {
    const detail = detailWith({ pendingApprovals: [pendingApproval('a')] });
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
  it('счётчики гейтов покрывают все статусы и сходятся с длиной входа', () => {
    const results = [
      { name: 'a', status: '✅', command: null, exitCode: null, lastLine: '', durationMs: 0, envBlocked: false },
      { name: 'b', status: '❌', command: null, exitCode: 1, lastLine: '', durationMs: 0, envBlocked: false },
      { name: 'c', status: '⏭', command: null, exitCode: null, lastLine: '', durationMs: 0, envBlocked: false },
      { name: 'd', status: '✅', command: null, exitCode: 0, lastLine: '', durationMs: 0, envBlocked: false },
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

describe('разбор патча по файлам (клиент режет текст, не пути и не счётчики)', () => {
  const patch = [
    'diff --git a/src/a.ts b/src/a.ts',
    'index 111..222 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,2 +1,2 @@',
    '-старое',
    '+новое',
    '+ещё строка',
    'diff --git a/b.ts b/b.ts',
    '--- a/b.ts',
    '+++ b/b.ts',
    '@@ -1 +1 @@',
    '-x',
    '+y',
  ].join('\n');

  it('блоки режутся по строке «diff --git », по числу файлов', () => {
    const blocks = splitPatchBlocks(patch);
    strictEqual(blocks.length, 2);
    ok(blocks[0]!.startsWith('diff --git a/src/a.ts'));
    ok(blocks[1]!.startsWith('diff --git a/b.ts'));
  });

  it('добавленная строка «+diff --git …» в теле не режет блок — начинается не с «diff --git »', () => {
    const withBodyLookalike = [
      'diff --git a/doc.md b/doc.md',
      '--- a/doc.md',
      '+++ b/doc.md',
      '@@ -1 +1,2 @@',
      ' x',
      '+diff --git a/f b/f',
    ].join('\n');
    strictEqual(splitPatchBlocks(withBodyLookalike).length, 1);
  });

  it('пустой патч — пустой список', () => {
    deepStrictEqual(splitPatchBlocks(''), []);
  });

  it('orderFiles сопоставляет серверный список с блоками позиционно и поднимает вне плана наверх', () => {
    const files = [
      { path: 'src/a.ts', inPlan: true, adds: 2, dels: 1 },
      { path: 'b.ts', inPlan: false, adds: 1, dels: 1 },
    ];
    const ordered = orderFiles(files, patch);
    strictEqual(ordered.length, 2);
    strictEqual(ordered[0]?.path, 'b.ts');
    strictEqual(ordered[0]?.inPlan, false);
    ok(ordered[0]!.text.startsWith('diff --git a/b.ts'));
    strictEqual(ordered[1]?.path, 'src/a.ts');
    strictEqual(ordered[1]?.inPlan, true);
    strictEqual(ordered[1]?.adds, 2);
  });

  it('файл без своего блока (расхождение с сервером) получает пустой текст, а не падает', () => {
    const ordered = orderFiles([{ path: 'src/a.ts', inPlan: true, adds: 2, dels: 1 }], '');
    strictEqual(ordered[0]?.text, '');
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

  it('вердикт красится из той же карты, что и панели, текст — отдельным, но общим правилом', () => {
    strictEqual(verdictTone(true), PANEL_TONE.ok);
    strictEqual(verdictTone(false), PANEL_TONE.fail);
    strictEqual(verdictTextTone(true), 'text-emerald-300');
    strictEqual(verdictTextTone(false), 'text-red-300');
  });

  it('заголовки diff не красятся как изменённые строки', () => {
    strictEqual(diffLineTone('+добавлено'), 'text-emerald-400');
    strictEqual(diffLineTone('-удалено'), 'text-red-400');
    ok(diffLineTone('+++ b/a.ts') !== 'text-emerald-400');
    ok(diffLineTone('--- a/a.ts') !== 'text-red-400');
    strictEqual(diffLineTone('@@ -1 +1 @@'), 'text-sky-400');
  });
});
