/**
 * `finalizeCheck.ts`: общая для флоу `loop`/`sdk` проверка «можно ли финализировать
 * артефакт» и локализация незаполненных мест в отказе.
 */

import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { describeMissingPlaceholders, finalizeRejection } from '../src/artifacts/finalizeCheck.ts';

describe('describeMissingPlaceholders', () => {
  it('без плейсхолдеров — count 0, located пуст', () => {
    const text = '# Задача: пример\n\n## Коротко\n\nВсё заполнено.\n';
    const r = describeMissingPlaceholders(text, null);
    strictEqual(r.count, 0);
    deepStrictEqual(r.located, []);
  });

  it('называет секцию и метку для каждого незаполненного поля', () => {
    const text =
      '# Задача: пример\n\n' +
      '## Коротко\n\n‹что делаем›\n\n' +
      '## Зачем\n\n- **Ветка витка:** ‹sdlc/слаг›\n';
    const r = describeMissingPlaceholders(text, null);
    strictEqual(r.count, 2);
    strictEqual(r.located.length, 2);
    // Секция нормализуется в нижний регистр (formSchema.ts: sectionKey → norm) — сообщение
    // ориентировано на модель, не на человека, и с этим форматом уже согласована схема.
    strictEqual(r.located.some((l) => l.includes('коротко')), true);
    strictEqual(r.located.some((l) => l.includes('ветка витка')), true);
  });

  it('обрезает длинный список и называет остаток', () => {
    const fields = ['Раз', 'Два', 'Три', 'Четыре', 'Пять', 'Шесть', 'Семь'];
    const text =
      '# Задача: пример\n\n' + fields.map((f) => `## ${f}\n\n‹значение›\n`).join('\n');
    const r = describeMissingPlaceholders(text, null);
    strictEqual(r.count, 7);
    strictEqual(r.located.length, 6); // 5 полей + одна строка «и ещё N»
    strictEqual(r.located[5], 'и ещё 2 мест');
  });

  it('таблица с несколькими пустыми строками одного вида — одна строка в located, не по одной на ‹…›', () => {
    const text =
      '# Задача: пример\n\n' +
      '## Что придётся тронуть\n\n' +
      '| путь | что меняем |\n' +
      '|---|---|\n' +
      '- ‹path/to/file› — ‹что здесь меняем›\n';
    const r = describeMissingPlaceholders(text, null);
    // Одна строка-образец таблицы даёт несколько placeholders в ОДНОМ поле — located
    // не должен раздуться до одной строки на каждый ‹…›.
    strictEqual(r.located.length, 1);
    strictEqual(r.count >= 1, true);
  });
});

describe('finalizeRejection — общая проверка обоих флоу (loop/sdk)', () => {
  it('артефакт не из списка этапа — отказ, null не возвращается', () => {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-finalize-'));
    const rejection = finalizeRejection('чужой.md', root, [join(root, 'intent.md')]);
    strictEqual(typeof rejection, 'string');
    strictEqual(rejection?.includes('не является артефактом этого этапа'), true);
  });

  it('пустой список formArtifacts — проверка по владению не ведётся', () => {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-finalize-'));
    writeFileSync(join(root, 'intent.md'), '# Задача: готово\n\nВсё заполнено.\n');
    strictEqual(finalizeRejection('intent.md', root, []), null);
  });

  it('артефакт не существует — отказ «сначала запиши»', () => {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-finalize-'));
    const rejection = finalizeRejection('нет-такого.md', root, []);
    strictEqual(rejection?.includes('не существует'), true);
  });

  it('плейсхолдеры остались — отказ называет число и локализацию', () => {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-finalize-'));
    writeFileSync(join(root, 'intent.md'), '# Задача: ‹название витка›\n\n## Коротко\n\n‹что делаем›\n');
    const rejection = finalizeRejection('intent.md', root, []);
    strictEqual(rejection?.includes('незаполненных мест'), true);
    strictEqual(rejection?.includes('коротко'), true);
  });

  it('готовый артефакт — null (финализация разрешена)', () => {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-finalize-'));
    writeFileSync(join(root, 'intent.md'), '# Задача: пример\n\nВсё на месте, мест `‹…›` нет.\n');
    strictEqual(finalizeRejection('intent.md', root, [join(root, 'intent.md')]), null);
  });

  it('абсолютный путь от модели резолвится как есть, относительный — от projectRoot', () => {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-finalize-'));
    const abs = join(root, 'intent.md');
    writeFileSync(abs, '# Задача: пример\n\nВсё на месте.\n');
    strictEqual(finalizeRejection(abs, root, [abs]), null);
    strictEqual(finalizeRejection('intent.md', root, [abs]), null);
  });
});
