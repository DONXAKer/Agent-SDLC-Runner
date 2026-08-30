/**
 * Границы h2-секций для проверки карты кодовой базы.
 *
 * Контракт из ревью-3: подзаголовки h3/h4 секцию НЕ закрывают (parseTables сбрасывает
 * section на любом заголовке — из-за этого таблицы карты под «### …» выпадали из проверки
 * сочинённых путей, fail-open).
 */

import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { h2SectionRanges } from '../src/run/stages.ts';

const TEXT = [
  '# Отчёт',
  '## Карта кодовой базы',
  'проза',
  '### Ключевые файлы',
  '| src/a.ts | ядро |',
  '## Другая секция',
  '| src/b.ts | мимо |',
  '## Карта повторно',
  '| src/c.ts | тоже карта |',
  '',
].join('\n');

describe('h2SectionRanges', () => {
  it('h3 внутри секции не закрывает её; закрывает только следующий h2', () => {
    const ranges = h2SectionRanges(TEXT, /карта/i);
    strictEqual(ranges.length, 2);
    const first = TEXT.slice(ranges[0]!.start, ranges[0]!.end);
    strictEqual(first.includes('### Ключевые файлы'), true);
    strictEqual(first.includes('src/a.ts'), true);
    strictEqual(first.includes('src/b.ts'), false);
    const second = TEXT.slice(ranges[1]!.start, ranges[1]!.end);
    strictEqual(second.includes('src/c.ts'), true);
  });

  it('без совпадающих заголовков — пусто', () => {
    deepStrictEqual(h2SectionRanges('## Одно\nтекст\n', /карта/i), []);
  });
});
