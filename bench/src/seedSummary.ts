/**
 * Сводка находимости посевов по уже накопленным `bench/results/*.json` — без прогона.
 *
 * `probeSeed` (`seeds.ts`) даёт «поймано / не поймано» ЗА ОДИН прогон; правило калибровки
 * («модель годна в `verify`, если находимость ≥ 2/3 при n ≥ 3») требует смотреть на СЕРИЮ.
 * До этого счёт вёлся вручную в `docs/model-runs.md` — здесь то же самое считает код по
 * файлам, которые уже лежат на диске, ничего не пересчитывая заново.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import type { BenchResult } from './result.ts';
import { buildReport } from './report.ts';
import { SEED_NONE } from './seeds.ts';

export interface SeedRunFacts {
  slug: string;
  model: string;
  seedId: string;
  klass: string;
  expected: 'gate' | 'review' | null;
  caught: boolean;
  /** `buildReport(...).exitCode !== 2` — то же правило «не измерено», не второе. */
  measured: boolean;
}

/**
 * `null` — прогон шёл без посева: сводке измерять нечего.
 *
 * `buildReport` считает не только код возврата — щупы по категориям скрытых тестов среди
 * прочего, и на результате старой схемы (`hidden` без `cases`, живьём попалось на реальном
 * `bench/results/`) падает исключением. Файл на диске от этого не «менее реален»: как и
 * битый JSON в `readResults`, такой результат исключается из знаменателя, а не роняет всю
 * сводку по соседним файлам.
 */
export function seedRunFacts(r: BenchResult): SeedRunFacts | null {
  // `=== null`, а не строгая проверка на `null`: результаты, записанные до появления поля
  // `seed` в `BenchResult`, дают здесь `undefined`, а не `null` — на реальном
  // `bench/results/` это оказался не гипотетический случай.
  if (r.seed === null || r.seed === undefined) return null;
  let measured: boolean;
  try {
    measured = buildReport({ result: r }).exitCode !== 2;
  } catch {
    measured = false;
  }
  return {
    slug: r.run.slug,
    model: r.run.model,
    seedId: r.seed.seedId,
    klass: r.seed.klass,
    expected: r.seed.expected,
    caught: r.seed.caught,
    measured,
  };
}

export interface SeedCell {
  caught: number;
  total: number;
  slugs: string[];
}

interface SeedClassInfo {
  seedId: string;
  klass: string;
  expected: 'gate' | 'review' | null;
}

export interface SeedSummary {
  models: string[];
  classes: SeedClassInfo[];
  /** Ключ — `${seedId}\0${model}`. */
  cells: Map<string, SeedCell>;
  /** Контроль без посева (`--seed none`), по модели: `caught` здесь значит «ложное срабатывание». */
  none: Map<string, SeedCell>;
  excluded: { slug: string; reason: string }[];
}

function bumpCell(m: Map<string, SeedCell>, key: string, caught: boolean, slug: string): void {
  const cell = m.get(key) ?? { caught: 0, total: 0, slugs: [] };
  cell.total += 1;
  if (caught) cell.caught += 1;
  cell.slugs.push(slug);
  m.set(key, cell);
}

export function summarizeSeeds(results: readonly BenchResult[]): SeedSummary {
  const models = new Set<string>();
  const classesById = new Map<string, SeedClassInfo>();
  const cells = new Map<string, SeedCell>();
  const none = new Map<string, SeedCell>();
  const excluded: { slug: string; reason: string }[] = [];

  for (const r of results) {
    const facts = seedRunFacts(r);
    if (facts === null) continue;
    models.add(facts.model);

    if (!facts.measured) {
      excluded.push({ slug: facts.slug, reason: 'измерение не состоялось (код 2 либо отчёт не строится на этом результате)' });
      continue;
    }

    if (facts.seedId === SEED_NONE) {
      bumpCell(none, facts.model, facts.caught, facts.slug);
      continue;
    }

    if (!classesById.has(facts.seedId)) {
      classesById.set(facts.seedId, { seedId: facts.seedId, klass: facts.klass, expected: facts.expected });
    }
    bumpCell(cells, `${facts.seedId}\0${facts.model}`, facts.caught, facts.slug);
  }

  return {
    models: [...models].sort(),
    classes: [...classesById.values()].sort((a, b) => a.seedId.localeCompare(b.seedId)),
    cells,
    none,
    excluded,
  };
}

export function renderSeedSummary(s: SeedSummary): string {
  const lines = ['# Сводка находимости посевов', ''];

  if (s.classes.length === 0 && s.none.size === 0) {
    lines.push('Посевных результатов не найдено в `bench/results/`.');
    return lines.join('\n');
  }

  if (s.classes.length > 0) {
    lines.push(
      `| Класс посева | Ожидание | ${s.models.join(' | ')} |`,
      `|---|---|${s.models.map(() => '---').join('|')}|`,
      ...s.classes.map((c) => {
        const row = s.models.map((m) => {
          const cell = s.cells.get(`${c.seedId}\0${m}`);
          return cell === undefined ? '—' : `${cell.caught}/${cell.total}`;
        });
        return `| ${c.klass} (\`${c.seedId}\`) | ${c.expected ?? '—'} | ${row.join(' | ')} |`;
      }),
      '',
    );
  }

  if (s.none.size > 0) {
    lines.push(
      '## Контроль без посева (`none`) — ложные срабатывания',
      '',
      '| Модель | Ложных / прогонов |',
      '|---|---|',
      ...s.models.filter((m) => s.none.has(m)).map((m) => `| ${m} | ${s.none.get(m)!.caught}/${s.none.get(m)!.total} |`),
      '',
    );
  }

  if (s.excluded.length > 0) {
    lines.push(
      `Исключено из знаменателя (код 2 — измерение не состоялось): ${s.excluded.length}`,
      '',
      ...s.excluded.map((e) => `- ${e.slug}: ${e.reason}`),
    );
  }

  return lines.join('\n');
}

/**
 * Только `*.json` каталога результатов; отчёты (`.report.md`) и прочее — не сюда. Битый
 * JSON не роняет сводку — уходит в `broken`, чтобы остальные файлы всё равно посчитались.
 */
export function readResults(dir: string): { results: BenchResult[]; broken: { file: string; reason: string }[] } {
  const results: BenchResult[] = [];
  const broken: { file: string; reason: string }[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return { results, broken };
  }
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    try {
      results.push(JSON.parse(readFileSync(join(dir, name), 'utf8')) as BenchResult);
    } catch (e) {
      broken.push({ file: name, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return { results, broken };
}
