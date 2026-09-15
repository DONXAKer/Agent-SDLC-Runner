/**
 * Живой ход прогона в консоль (`progress.ts`): этап, операции, ветки решений, контекст.
 * Проверяется только форма строк — печать ни на что не влияет и в результат не пишет.
 */

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { emptyUsage } from '@sdlc-runner/shared';
import type { RunEvent } from '@sdlc-runner/shared';

import { contextLine, createProgressPrinter } from '../src/progress.ts';

function printer(window: number | undefined): { lines: string[]; emit: (e: RunEvent) => void } {
  const lines: string[] = [];
  const emit = createProgressPrinter({
    contextWindowFor: () => window,
    routeFor: () => 'lmstudio:qwen3-8b',
    write: (l) => lines.push(l),
    now: () => new Date('2026-09-15T10:00:00'),
  });
  return { lines, emit };
}

describe('contextLine', () => {
  it('доля окна в процентах; без окна — названо, что оно не задано', () => {
    strictEqual(contextLine(16384, 32768), `${(16384).toLocaleString('ru-RU')} / ${(32768).toLocaleString('ru-RU')} (50%)`);
    ok(contextLine(1000, undefined).includes('окно не задано'));
  });
});

describe('createProgressPrinter', () => {
  it('этап: заголовок с моделью и окном, запросы с контекстом, итог с пиком', () => {
    const { lines, emit } = printer(32768);
    emit({ type: 'stage_started', runId: 'r', stage: 'intent', flow: 'loop', provider: 'lmstudio', model: 'm', chunk: 1, attempt: 1 });
    emit({ type: 'usage', runId: 'r', stage: 'intent', usage: { ...emptyUsage(), inputTokens: 8192, outputTokens: 300 }, total: emptyUsage() });
    emit({ type: 'usage', runId: 'r', stage: 'intent', usage: { ...emptyUsage(), inputTokens: 16384, outputTokens: 100 }, total: emptyUsage() });
    emit({ type: 'stage_done', runId: 'r', stage: 'intent', ok: false, note: 'модель упёрлась в лимит длины ответа' });

    ok(lines[0]?.includes('▶') && lines[0].includes('intent') && lines[0].includes('lmstudio:qwen3-8b'), lines[0]);
    ok(lines[1]?.includes('запрос 1') && lines[1].includes('(25%)'), lines[1]);
    ok(lines[2]?.includes('запрос 2') && lines[2].includes('(50%)'), lines[2]);
    ok(lines[3]?.includes('❌') && lines[3].includes('запросов к модели 2') && lines[3].includes('(50%)'), lines[3]);
    ok(lines[3]?.includes('лимит длины ответа'), lines[3]);
  });

  it('отказ политики печатается один раз — на запросе, без повтора на решении', () => {
    const { lines, emit } = printer(undefined);
    emit({
      type: 'tool_request',
      runId: 'r',
      stage: 'explore',
      requestId: 'q',
      toolName: 'Write',
      rawInput: {},
      call: { kind: 'write', path: 'src/a.ts', content: 'x' },
      policy: { ok: false, policy: 'stageTools', reason: 'запись на разведке не выдана' },
      preview: null,
      writeTargets: null,
      destructive: null,
      createdAt: 0,
    });
    emit({ type: 'tool_resolved', runId: 'r', stage: 'explore', requestId: 'q', decision: { allowed: false, reason: 'политика', by: 'policy' } });
    strictEqual(lines.length, 1);
    ok(lines[0]?.includes('Write src/a.ts') && lines[0].includes('[stageTools]'), lines[0]);
  });

  it('снятый обрывом вызов — не отказ; ветка рантайма (warning) видна', () => {
    const { lines, emit } = printer(32768);
    emit({ type: 'tool_resolved', runId: 'r', stage: 'chunk', requestId: 'c', decision: { allowed: false, reason: 'прогон отменён', by: 'operator' }, cancelled: true });
    emit({ type: 'warning', runId: 'r', stage: 'intent', message: 'рантайм заполнил механические поля (3)' });
    deepStrictEqual(lines, ['    снят обрывом: прогон отменён', '  ⚠ рантайм заполнил механические поля (3)']);
  });

  it('обмен с моделью: вопрос первой непустой строкой, ответ построчно; пустой ответ назван', () => {
    const { lines, emit } = printer(32768);
    emit({
      type: 'model_exchange',
      runId: 'r',
      stage: 'intent',
      question: '\n\n## Поле «Итог»\nПлейсхолдер: ‹что должно стать правдой›',
      answer: 'Бесплатная доставка\nдля крупных отправлений',
    });
    emit({ type: 'model_exchange', runId: 'r', stage: 'intent', question: 'Поле «Зачем»', answer: '  ' });
    deepStrictEqual(lines, [
      '  ? ## Поле «Итог»',
      '    │ Бесплатная доставка',
      '    │ для крупных отправлений',
      '  ? Поле «Зачем»',
      '    │ (пустой ответ)',
    ]);
  });

  it('длинный ответ обрезан; текст ассистента этапа с циклом — одной строкой', () => {
    const { lines, emit } = printer(32768);
    emit({ type: 'model_exchange', runId: 'r', stage: 'explore', question: 'q', answer: 'x'.repeat(5000) });
    ok(lines[1]!.endsWith('…') && lines[1]!.length < 1600, String(lines[1]?.length));
    emit({ type: 'assistant_text', runId: 'r', stage: 'chunk', text: 'Прочитаю\nфайл' });
    strictEqual(lines.at(-1), '  ‹ Прочитаю файл');
  });
});
