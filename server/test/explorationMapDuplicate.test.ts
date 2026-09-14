/**
 * `explorationPathProblem` — новая ветка: несколько секций «Карта кодовой базы» в одном
 * отчёте разведки.
 *
 * Живой замер серии v4, `qwencoder`/`silent-contract`, 2026-09-14: дозаполнение оставило
 * исходный заголовок «## Карта кодовой базы» с одной легендой (без таблицы) и завело РЯДОМ
 * свой заголовок «## 🗺️ Карта кодовой базы (Что сейчас / Что меняем)» со свободным текстом
 * вместо таблицы. Построчная проверка путей смотрит только НАЙДЕННЫЕ таблицы — пустая секция
 * без единой таблицы проходит её молча, и подмена структуры оставалась незамеченной.
 */

import { ok, strictEqual } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { WitokPaths } from '../src/artifacts/paths.ts';
import { explorationPathProblem } from '../src/run/stages.ts';
import type { StageContext } from '../src/run/stages.ts';

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function ctx(reportText: string): StageContext {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sdlc-explore-map-')));
  roots.push(root);
  mkdirSync(join(root, '.sdlc', 'demo'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'tariffs.ts'), 'export const tariffs = 1;\n');
  const paths = new WitokPaths(root, 'demo');
  writeFileSync(paths.explorationReport, reportText);
  return { paths, chunk: 1, attempt: 1 };
}

const NORMAL_REPORT = [
  '# Отчёт разведки',
  '',
  '## Карта кодовой базы',
  '',
  '| Файл | Что там сейчас | Что меняем |',
  '|---|---|---|',
  '| `src/tariffs.ts` | функция priceFor | добавить surcharge |',
  '',
  '## Найдено для переиспользования',
  '',
].join('\n');

// Посторонний заголовок со словом «карта», но не про карту кодовой базы — регэксп без
// группировки слов («карта» ИЛИ «кодовая база» по отдельности) читал бы его как вторую
// секцию карты (code-review-all, 2026-09-14).
const UNRELATED_MAP_HEADING_REPORT = [
  '# Отчёт разведки',
  '',
  '## Карта кодовой базы',
  '',
  '| Файл | Что там сейчас | Что меняем |',
  '|---|---|---|',
  '| `src/tariffs.ts` | функция priceFor | добавить surcharge |',
  '',
  '## Карта рисков',
  '',
  'Риск переполнения буфера при негабарите — см. claim-2.',
  '',
].join('\n');

const DUPLICATED_REPORT = [
  '# Отчёт разведки',
  '',
  '## Карта кодовой базы',
  '_Только файлы, относящиеся к задаче._',
  '',
  '## 🗺️ Карта кодовой базы (Что сейчас / Что меняем)',
  'Поиск релевантных файлов не дал результатов, поэтому карта пуста.',
  '',
  '## Найдено для переиспользования',
  '',
].join('\n');

describe('explorationPathProblem: дублированная секция «Карта кодовой базы»', () => {
  it('одна секция с таблицей реальных путей — проблемы нет', () => {
    strictEqual(explorationPathProblem(ctx(NORMAL_REPORT)), null);
  });

  it('две секции с этим заголовком (структура подменена прозой) — находка, не null', () => {
    const problem = explorationPathProblem(ctx(DUPLICATED_REPORT));
    ok(problem !== null);
    ok(problem.includes('несколько секций'), problem ?? '');
    ok(problem.includes('Карта кодовой базы'), problem ?? '');
  });

  it('посторонний заголовок со словом «карта» («Карта рисков») — не ложный дубль', () => {
    strictEqual(explorationPathProblem(ctx(UNRELATED_MAP_HEADING_REPORT)), null);
  });

  // Признак без якоря ловил «кодов» и «кодовой базе» в любом месте заголовка (code-review, 2026-09-15).
  it('«Карта кодов ошибок» и «Что уже есть в кодовой базе» с прозой — не вторая карта', () => {
    for (const heading of ['## Карта кодов ошибок', '## Что уже есть в кодовой базе']) {
      const report = [NORMAL_REPORT, heading, '', 'Проза без таблицы.', ''].join('\n');
      strictEqual(explorationPathProblem(ctx(report)), null, heading);
    }
  });

  it('две секции карты, обе с таблицами реальных путей, — честная разбивка, не дубль', () => {
    const report = [
      '# Отчёт разведки',
      '',
      '## Карта кодовой базы',
      '',
      '| Файл | Что там сейчас | Что меняем |',
      '|---|---|---|',
      '| `src/tariffs.ts` | функция priceFor | добавить surcharge |',
      '',
      '## Карта кодовой базы — ключевые файлы',
      '',
      '| Файл | Роль |',
      '|---|---|',
      '| `src/tariffs.ts` | тарифы |',
      '',
    ].join('\n');
    strictEqual(explorationPathProblem(ctx(report)), null);
  });

  it('переименованный заголовок «## Кодовая база» с выдуманным путём — проверка не отключается', () => {
    const report = [
      '# Отчёт разведки',
      '',
      '## Кодовая база',
      '',
      '| Файл | Что там сейчас |',
      '|---|---|',
      '| `src/loyalty.ts` | скидки лояльности |',
      '',
    ].join('\n');
    const problem = explorationPathProblem(ctx(report));
    ok(problem !== null && problem.includes('src/loyalty.ts'), problem ?? 'проверка молчит');
  });
});
