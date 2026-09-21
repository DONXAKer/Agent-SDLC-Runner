/**
 * Сводка находимости посевов — чистое ядро над уже накопленными `result.json`.
 *
 * Проверяется то же, что путает счёт вручную в журнале: код 2 («не измерено») не должен
 * попадать в знаменатель, `none` считается отдельно и по-другому («ложное», не «поймано»),
 * а битый файл на диске не должен ронять сводку по остальным.
 */

import { deepStrictEqual, match, ok, strictEqual } from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import type { RunMetrics } from '@sdlc-runner/shared';

import { emptyCollectorState } from '../src/collector.ts';
import { emptyOperatorLog } from '../src/operator.ts';
import type { BenchResult } from '../src/result.ts';
import { SEED_NONE } from '../src/seeds.ts';
import type { SeedProbe } from '../src/seeds.ts';
import { readResults, renderSeedSummary, seedRunFacts, summarizeSeeds } from '../src/seedSummary.ts';

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function emptyMetrics(): RunMetrics {
  return { stages: [], verdicts: { total: 0, red: 0 }, redByCause: [], attemptsByChunk: [], friction: [], gates: [], human: [], artifactGaps: [], chunkEvidence: [] };
}

/** Прогон, который дошёл до модели хотя бы раз — `measuredAtAll` в `buildReport`. */
function measuredResult(over: {
  slug: string;
  model: string;
  seed: SeedProbe | null;
  timedOut?: boolean;
}): BenchResult {
  return {
    run: {
      slug: over.slug,
      model: over.model,
      task: 'oversize',
      fixtureDir: 'fixture',
      mode: { kind: 'stage', stage: 'verify' },
      profileLabel: 'demo',
      routes: {
        intent: 'm', explore: 'm', ask: 'm', plan: 'm', chunk: 'm', verify: over.model, handoff: 'm',
      },
      currencies: { intent: 'USD', explore: 'USD', ask: 'USD', plan: 'USD', chunk: 'USD', verify: 'USD', handoff: 'USD' },
      measured: ['verify'],
      startedAt: '2026-09-21T00:00:00.000Z',
      finishedAt: '2026-09-21T00:05:00.000Z',
    },
    driver: {
      stages: [
        {
          stage: 'verify',
          chunk: 1,
          attempt: 1,
          ok: true,
          note: 'этап завершён',
          blockers: [],
          timedOut: over.timedOut ?? false,
          skipped: false,
        },
      ],
      finalVerdict: { passed: true, action: 'continue', reasons: [] },
      stopped: 'handoff',
    },
    metrics: emptyMetrics(),
    finalVerdict: { passed: true, action: 'continue', reasons: [] },
    operator: emptyOperatorLog(),
    observed: emptyCollectorState(),
    seed: over.seed,
    hidden: null,
    honesty: [],
  };
}

/** Прогон, который до модели не дошёл вовсе — блокер на самом первом этапе (код 2). */
function unmeasuredResult(over: { slug: string; model: string; seed: SeedProbe | null }): BenchResult {
  const r = measuredResult(over);
  r.driver.stages = [
    {
      stage: 'verify',
      chunk: 1,
      attempt: 1,
      ok: false,
      note: 'этап не стартовал',
      blockers: ['входной артефакт не готов'],
      timedOut: false,
      skipped: false,
    },
  ];
  return r;
}

function seedProbe(over: Partial<SeedProbe> & { seedId: string }): SeedProbe {
  return {
    klass: 'тестовый класс',
    expected: 'review',
    caught: true,
    where: ['report'],
    note: 'тест',
    ...over,
  };
}

describe('seedRunFacts', () => {
  it('прогон без посева — null', () => {
    strictEqual(seedRunFacts(measuredResult({ slug: 's1', model: 'm1', seed: null })), null);
  });

  it('measured считается по buildReport().exitCode, не второй раз', () => {
    const caught = seedRunFacts(
      measuredResult({ slug: 's1', model: 'm1', seed: seedProbe({ seedId: 'silent-price-change', caught: true }) }),
    );
    ok(caught !== null);
    strictEqual(caught.measured, true);

    const blocked = seedRunFacts(
      unmeasuredResult({ slug: 's2', model: 'm1', seed: seedProbe({ seedId: 'silent-price-change', caught: false }) }),
    );
    ok(blocked !== null);
    strictEqual(blocked.measured, false);
  });
});

describe('summarizeSeeds', () => {
  it('2 модели × 2 класса — клетки k/n по каждой паре', () => {
    const results: BenchResult[] = [
      measuredResult({ slug: 'a1', model: 'gpt-oss-20b', seed: seedProbe({ seedId: 'silent-price-change', klass: 'молчаливая правка', caught: true }) }),
      measuredResult({ slug: 'a2', model: 'gpt-oss-20b', seed: seedProbe({ seedId: 'silent-price-change', klass: 'молчаливая правка', caught: false }) }),
      measuredResult({ slug: 'a3', model: 'qwen3-8b', seed: seedProbe({ seedId: 'silent-price-change', klass: 'молчаливая правка', caught: true }) }),
      measuredResult({ slug: 'a4', model: 'gpt-oss-20b', seed: seedProbe({ seedId: 'axis-config-blind', klass: 'ось: настройки', caught: false }) }),
    ];
    const s = summarizeSeeds(results);
    deepStrictEqual(s.models, ['gpt-oss-20b', 'qwen3-8b']);
    strictEqual(s.classes.length, 2);
    deepStrictEqual(s.cells.get('silent-price-change\0gpt-oss-20b'), { caught: 1, total: 2, slugs: ['a1', 'a2'] });
    deepStrictEqual(s.cells.get('silent-price-change\0qwen3-8b'), { caught: 1, total: 1, slugs: ['a3'] });
    deepStrictEqual(s.cells.get('axis-config-blind\0gpt-oss-20b'), { caught: 0, total: 1, slugs: ['a4'] });
    strictEqual(s.cells.get('axis-config-blind\0qwen3-8b'), undefined);
  });

  it('прогон с кодом 2 исключён из знаменателя и назван в excluded', () => {
    const results: BenchResult[] = [
      unmeasuredResult({ slug: 'b1', model: 'm1', seed: seedProbe({ seedId: 'silent-price-change', caught: false }) }),
      measuredResult({ slug: 'b2', model: 'm1', seed: seedProbe({ seedId: 'silent-price-change', caught: true }) }),
    ];
    const s = summarizeSeeds(results);
    deepStrictEqual(s.cells.get('silent-price-change\0m1'), { caught: 1, total: 1, slugs: ['b2'] });
    strictEqual(s.excluded.length, 1);
    strictEqual(s.excluded[0]?.slug, 'b1');
  });

  it('результат, на котором buildReport падает (старая схема), исключён, а не роняет сводку', () => {
    const broken = measuredResult({ slug: 'e1', model: 'm1', seed: seedProbe({ seedId: 'silent-price-change', caught: true }) });
    // Старый формат `hidden`: объект есть, но без `cases` — ровно то, что уронило
    // `probeByCategory` на реальном bench/results/.
    (broken as unknown as { hidden: unknown }).hidden = {};
    const ok = measuredResult({ slug: 'e2', model: 'm1', seed: seedProbe({ seedId: 'silent-price-change', caught: true }) });
    const s = summarizeSeeds([broken, ok]);
    deepStrictEqual(s.cells.get('silent-price-change\0m1'), { caught: 1, total: 1, slugs: ['e2'] });
    strictEqual(s.excluded.some((e) => e.slug === 'e1'), true);
  });

  it('none считается отдельно от классов посева, как ложные срабатывания', () => {
    const results: BenchResult[] = [
      measuredResult({ slug: 'c1', model: 'm1', seed: seedProbe({ seedId: SEED_NONE, klass: 'без посева — проверка ложных срабатываний', expected: null, caught: false }) }),
      measuredResult({ slug: 'c2', model: 'm1', seed: seedProbe({ seedId: SEED_NONE, klass: 'без посева — проверка ложных срабатываний', expected: null, caught: true }) }),
    ];
    const s = summarizeSeeds(results);
    strictEqual(s.classes.length, 0);
    deepStrictEqual(s.none.get('m1'), { caught: 1, total: 2, slugs: ['c1', 'c2'] });
  });
});

describe('renderSeedSummary', () => {
  it('рендерит долю k/n в ячейке таблицы', () => {
    const s = summarizeSeeds([
      measuredResult({ slug: 'd1', model: 'm1', seed: seedProbe({ seedId: 'silent-price-change', klass: 'молчаливая правка', caught: true }) }),
      measuredResult({ slug: 'd2', model: 'm1', seed: seedProbe({ seedId: 'silent-price-change', klass: 'молчаливая правка', caught: true }) }),
      measuredResult({ slug: 'd3', model: 'm1', seed: seedProbe({ seedId: 'silent-price-change', klass: 'молчаливая правка', caught: false }) }),
    ]);
    const md = renderSeedSummary(s);
    match(md, /2\/3/);
    match(md, /молчаливая правка/);
  });

  it('без посевных результатов — сказано прямо, не пустая таблица', () => {
    const md = renderSeedSummary(summarizeSeeds([]));
    match(md, /не найдено/);
  });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'sdlc-seed-summary-'));
  roots.push(root);
  return root;
}

describe('readResults', () => {
  it('читает только *.json, пропускает .report.md', () => {
    const dir = tempRoot();
    writeFileSync(join(dir, 'a.json'), JSON.stringify(measuredResult({ slug: 'a', model: 'm', seed: null })));
    writeFileSync(join(dir, 'a.report.md'), '# отчёт\n');
    const { results, broken } = readResults(dir);
    strictEqual(results.length, 1);
    strictEqual(broken.length, 0);
  });

  it('битый JSON уходит в broken, остальные файлы считаются', () => {
    const dir = tempRoot();
    writeFileSync(join(dir, 'good.json'), JSON.stringify(measuredResult({ slug: 'good', model: 'm', seed: null })));
    writeFileSync(join(dir, 'bad.json'), 'не json вовсе');
    const { results, broken } = readResults(dir);
    strictEqual(results.length, 1);
    strictEqual(broken.length, 1);
    strictEqual(broken[0]?.file, 'bad.json');
  });

  it('отсутствующий каталог — пустой результат, не исключение', () => {
    const dir = join(tempRoot(), 'нет-такого');
    const { results, broken } = readResults(dir);
    deepStrictEqual(results, []);
    deepStrictEqual(broken, []);
  });
});
