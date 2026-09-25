/**
 * `archive.ts` — что остаётся на месте (последний прогон каждой модели) и как
 * переписываются ссылки документов на уехавшие отчёты.
 */

import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { baseModel, planKeep, rewriteLinks, runFacts } from '../src/archive.ts';
import type { RunFacts } from '../src/archive.ts';

const day = (d: number): number => Date.parse(`2026-09-${String(d).padStart(2, '0')}T12:00:00Z`);

function run(slug: string, over: Partial<RunFacts> = {}): RunFacts {
  return { slug, model: 'ollama:qwen', startedMs: day(10), ...over };
}

describe('planKeep', () => {
  it('по одному прогону на модель — самый поздний; контроль и задачи не в счёт', () => {
    const keep = planKeep([
      run('old-1', { startedMs: day(1) }),
      run('new-1', { startedMs: day(24) }),
      run('other-task', { startedMs: day(2) }),
      run('ctl-old', { model: 'claude-sdk:sonnet', startedMs: day(1) }),
      run('ctl-new', { model: 'claude-sdk:sonnet', startedMs: day(3) }),
    ]);
    deepStrictEqual([...keep].sort(), ['ctl-new', 'new-1']);
  });

  it('варианты одной модели у разных провайдеров и с ручками — одна модель', () => {
    const keep = planKeep([
      run('a', { model: 'ollama:gpt-oss-20b-agent-stepfill', startedMs: day(1) }),
      run('b', { model: 'lmstudio:gpt-oss-20b-f16', startedMs: day(3) }),
      run('c', { model: 'polza:gpt-oss-20b', startedMs: day(2) }),
    ]);
    deepStrictEqual([...keep], ['b']);
  });

  it('при равном начале план не зависит от порядка', () => {
    const a = run('a', { startedMs: day(1) });
    const b = run('b', { startedMs: day(1) });
    deepStrictEqual([...planKeep([a, b])], ['b']);
    deepStrictEqual([...planKeep([b, a])], ['b']);
  });
});

describe('baseModel', () => {
  it('снимает провайдера, публикатора, ручки и окно; сводит написания тегов', () => {
    const cases: [string, string][] = [
      ['ollama:gpt-oss-20b-effort-high-rf', 'gpt-oss-20b'],
      ['ollama:granite4.2-8b-ctx32k-nofill', 'granite4.2-8b'],
      ['lmstudio:gemma-4-e4b-stepfill-axisfill', 'gemma4-e4b'],
      ['ollama:qwen3:8b-ctx16k', 'qwen3-8b'],
      ['polza:qwen3-30b-a3b-41k', 'qwen3-30b-a3b'],
      ['lmstudio:ministral3-14b-reasoning-selfreview', 'ministral3-14b-reasoning'],
      ['lmstudio:qwen38-27b-stepfill', 'qwen3.8-27b'],
      ['ollama:qwen3-coder-30b-a3b', 'qwen3-coder-30b'],
      ['claude-sdk:sonnet', 'sonnet'],
    ];
    for (const [id, base] of cases) strictEqual(baseModel(id), base, id);
  });

  // `instruct`/`reasoning` — не ручки раннера, а обученные варианты с разной пригодностью
  // по этапам (`docs/model-task-matrix.md`): снятые как ручка, они делили бы одну базовую
  // модель и одну карточку архива между собой (code-review-all, 2026-09-26).
  it('instruct и reasoning — разные базовые модели, не ручка одной', () => {
    strictEqual(baseModel('ollama:ministral3-14b-instruct-ctx32k'), 'ministral3-14b-instruct');
    strictEqual(baseModel('lmstudio:ministral3-14b-reasoning'), 'ministral3-14b-reasoning');
  });

  // `effort`/`high`/`low` — наоборот, тот же вес под другим значением reasoning effort
  // (`docs/model-runs.md`: «тот же вес» — тег `effort-low` для qwen3.8-27b удалён как
  // неотличимый в пределах шума); знак, что они собираются в одну базовую модель.
  it('effort-low/effort-high — та же базовая модель, что и голая', () => {
    strictEqual(baseModel('ollama:gpt-oss-20b-effort-low'), 'gpt-oss-20b');
    strictEqual(baseModel('ollama:gpt-oss-20b-effort-high-rf'), 'gpt-oss-20b');
    strictEqual(baseModel('ollama:gpt-oss-20b'), 'gpt-oss-20b');
  });
});

describe('runFacts', () => {
  it('модель и дата из результата; не результат — null', () => {
    deepStrictEqual(runFacts({ run: { model: 'm', startedAt: '2026-09-10T12:00:00Z' } }, 'x', 0), { slug: 'x', model: 'm', startedMs: day(10) });
    strictEqual(runFacts({ series: [] }, 'sum', 0), null);
    strictEqual(runFacts({ run: { model: 'm' } }, 'y', 42)?.startedMs, 42);
  });
});

describe('rewriteLinks', () => {
  it('переписывает только уехавшие имена целиком, архивные не трогает', () => {
    const text = [
      'см. bench/results/x-1.report.md.',
      '`bench/results/x-1.json`, bench/results/x-10.json',
      'слаг bench/results/x-1 и bench/results/day.log',
      'уже bench/archive/results/x-1.json',
    ].join('\n');
    strictEqual(
      rewriteLinks(text, new Set(['x-1.json', 'x-1.report.md', 'day.log']), new Set(['x-1'])),
      [
        'см. bench/archive/results/x-1.report.md.',
        '`bench/archive/results/x-1.json`, bench/results/x-10.json',
        'слаг bench/archive/results/x-1 и bench/archive/results/day.log',
        'уже bench/archive/results/x-1.json',
      ].join('\n'),
    );
  });
});
