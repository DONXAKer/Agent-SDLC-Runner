/**
 * `sheet.ts`: разбор ответа модели на поле бланка и компактная проекция входа.
 *
 * Прогон `renderSheet` по реальным заполненным примерам эталона пропускается с названной
 * причиной, если их нет на машине, — конвенция репозитория (`server/test/prompt.test.ts`).
 */

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { loadConfig } from '../src/config/load.ts';
import { deriveSchema, findField } from '../src/artifacts/formSchema.ts';
import {
  cleanAnswer,
  isSheetError,
  matchChoice,
  parseFieldValue,
  parseListItems,
  parseRecordRows,
  renderSheet,
} from '../src/artifacts/sheet.ts';

function нетЭталона(dir: string): string | false {
  return existsSync(dir) ? false : `нет эталона методологии на этой машине: ${dir}`;
}

describe('cleanAnswer', () => {
  it('снимает fenced-обёртку', () => {
    strictEqual(cleanAnswer('```\nтекст\n```'), 'текст');
    strictEqual(cleanAnswer('```markdown\nтекст\n```'), 'текст');
  });

  it('снимает внешние кавычки-ёлочки', () => {
    strictEqual(cleanAnswer('«готово»'), 'готово');
  });

  it('обычный текст не трогает', () => {
    strictEqual(cleanAnswer('  готово  '), 'готово');
  });
});

describe('matchChoice', () => {
  const glyphs = [
    { key: '✅', text: '✅', commentSlot: false, free: false },
    { key: '❌', text: '❌', commentSlot: false, free: false },
    { key: '⏭', text: '⏭', commentSlot: false, free: false },
  ];

  it('глиф в ответе', () => {
    deepStrictEqual(matchChoice(glyphs, '✅'), { key: '✅', comment: '' });
  });

  it('слово-синоним через общий словарь claimStatusOf', () => {
    deepStrictEqual(matchChoice(glyphs, 'passed'), { key: '✅', comment: '' });
    deepStrictEqual(matchChoice(glyphs, 'failed'), { key: '❌', comment: '' });
  });

  it('словарный ключ методологии — точное совпадение', () => {
    const opts = [
      { key: 'полный', text: 'полный', commentSlot: false, free: false },
      { key: 'мелкий', text: 'мелкий', commentSlot: false, free: false },
    ];
    deepStrictEqual(matchChoice(opts, 'мелкий'), { key: 'мелкий', comment: '' });
  });

  it('свободный вариант — весь ответ становится значением', () => {
    const opts = [
      { key: 'имя дата', text: '‹имя› · ‹дата›', commentSlot: false, free: true },
      { key: 'не одобрен', text: '**не одобрен**', commentSlot: false, free: false },
    ];
    deepStrictEqual(matchChoice(opts, 'Иван · 2026-09-02'), {
      key: 'имя дата',
      comment: 'Иван · 2026-09-02',
    });
  });

  it('ни один вариант не подошёл — null', () => {
    strictEqual(matchChoice(glyphs, 'что-то совсем другое'), null);
  });
});

describe('parseListItems', () => {
  it('маркированный список — по элементу на строку', () => {
    deepStrictEqual(parseListItems('- первый\n- второй'), ['первый', 'второй']);
  });

  it('нумерованный список', () => {
    deepStrictEqual(parseListItems('1. первый\n2. второй'), ['первый', 'второй']);
  });

  it('без маркеров — построчный запасной разбор', () => {
    deepStrictEqual(parseListItems('первый\nвторой'), ['первый', 'второй']);
  });

  it('продолжение элемента на отступе склеивается', () => {
    deepStrictEqual(parseListItems('- длинный элемент\n  продолжение'), ['длинный элемент продолжение']);
  });

  it('пустой ответ — пустой список', () => {
    deepStrictEqual(parseListItems(''), []);
  });
});

describe('parseRecordRows', () => {
  const columns = [
    { id: 'путь', header: 'path/to/file', kind: 'scalar' },
    { id: 'что здесь меняем', header: 'что здесь меняем', kind: 'scalar' },
  ];

  it('форма 1: явные имена колонок', () => {
    const rows = parseRecordRows('- путь: src/a.ts\n  что здесь меняем: добавить X', columns);
    deepStrictEqual(rows, [{ путь: 'src/a.ts', 'что здесь меняем': 'добавить X' }]);
  });

  it('форма 2: позиционно через тире', () => {
    const rows = parseRecordRows('- src/a.ts — добавить X\n- src/b.ts — убрать Y', columns);
    deepStrictEqual(rows, [
      { путь: 'src/a.ts', 'что здесь меняем': 'добавить X' },
      { путь: 'src/b.ts', 'что здесь меняем': 'убрать Y' },
    ]);
  });

  it('форма 3: pipe-таблица — запасной синтаксис', () => {
    const rows = parseRecordRows('| src/a.ts | добавить X |', columns);
    deepStrictEqual(rows, [{ путь: 'src/a.ts', 'что здесь меняем': 'добавить X' }]);
  });

  it('колонка id — mechanical, из ответа не ожидается', () => {
    const withId = [
      { id: 'id', header: 'id', kind: 'mechanical' },
      { id: 'пункт', header: 'Пункт', kind: 'scalar' },
      { id: 'как проверить', header: 'Как проверить', kind: 'scalar' },
    ];
    const rows = parseRecordRows('| claim-1 | поведение | критерий |', withId);
    deepStrictEqual(rows, [{ пункт: 'поведение', 'как проверить': 'критерий' }]);
  });

  it('пустой ответ — пустой список записей', () => {
    deepStrictEqual(parseRecordRows('', columns), []);
  });
});

describe('parseFieldValue', () => {
  it('scalar: эхо метки в первой строке снимается', () => {
    const s = deriveSchema('# Задача\n\n- **Ветка витка:** ‹sdlc/слаг›\n');
    const f = findField(s, 'ветка витка')!;
    const v = parseFieldValue(f, '- **Ветка витка:** sdlc/oversize');
    ok(!isSheetError(v));
    strictEqual(v.kind === 'text' ? v.text : '', 'sdlc/oversize');
  });

  it('choice: неизвестный ответ — ошибка с перечнем вариантов', () => {
    const s = deriveSchema('# Задача\n\n- **Контур:** полный / мелкий — критерий\n');
    const f = findField(s, 'контур')!;
    const v = parseFieldValue(f, 'что-то другое');
    ok(isSheetError(v));
  });

  it('records: приёмочный лист по образцу шаблона', () => {
    const text = [
      '## Приёмочный лист',
      '',
      '| id | Пункт | Как проверить (процедура + критерий) |',
      '|----|-------|--------------------------------------|',
      '| claim-1 | ‹наблюдаемое поведение› | ‹процедура и критерий годности› |',
      '',
    ].join('\n');
    const s = deriveSchema(text);
    const f = findField(s, 'приемочный лист')!;
    const v = parseFieldValue(
      f,
      '- пункт: код 200 на повторе\n  как проверить: PaymentIdempotencyIT.retryReturns200',
    );
    ok(!isSheetError(v));
    ok(v.kind === 'records' && v.rows.length === 1);
  });
});

// ---------------------------------------------------------------------------
// renderSheet — на реальных заполненных примерах эталона
// ---------------------------------------------------------------------------

const cfg = loadConfig();
const exampleDir = join(cfg.runner.methodologyDir, 'example');

describe('renderSheet: герметичные случаи', () => {
  it('убирает цитату-шапку и легенду курсивом', () => {
    const text = [
      '# План: ‹название витка›',
      '',
      "> Этап 4. Заполняет агент, **одобряет человек**.",
      '',
      '## Подход',
      '_Одно-два предложения: как решаем._',
      '',
      'Переиспользуем guard.',
    ].join('\n');
    const out = renderSheet(text);
    ok(!out.includes('Этап 4'));
    ok(!out.includes('Одно-два предложения'));
    ok(out.includes('Переиспользуем guard.'));
  });

  it('строка-метка сжимается без разметки', () => {
    const out = renderSheet('- **Ветка витка:** sdlc/oversize\n');
    strictEqual(out, 'ветка витка: sdlc/oversize');
  });

  it('таблица: разделитель `|---|` вырезан, строки данных остаются строками', () => {
    // Разворот строки таблицы в запись `- колонка: значение` не даёт выигрыша байт ни на
    // одной реальной конвенции этого репозитория (ячейки шаблонов не подбиты пробелами —
    // у строки `| a | b |` разметки на границу меньше, чем у записи с переводом строки и
    // отступом продолжения), поэтому проекция оставляет таблицу таблицей и снимает только
    // разделитель — он не несёт значений и читающей модели не нужен вовсе.
    const text = ['| id | Пункт |', '|---|---|', '| claim-1 | код 200 на повторе |'].join('\n');
    const out = renderSheet(text);
    ok(out.includes('| id | Пункт |'));
    ok(!out.includes('|---|'));
    ok(out.includes('| claim-1 | код 200 на повторе |'));
    ok(Buffer.byteLength(out, 'utf8') < Buffer.byteLength(text, 'utf8'));
  });

  it('fenced-блок (yaml handoff) остаётся дословно', () => {
    const text = ['```yaml', 'slug: pay-412', 'branch: sdlc/pay-412', '```'].join('\n');
    strictEqual(renderSheet(text), text);
  });
});

describe('renderSheet: реальные заполненные примеры эталона', { skip: нетЭталона(exampleDir) }, () => {
  const files = readdirSync(exampleDir).filter((f) => f.endsWith('.md'));

  it('каждый пример сжимается без исключений и остаётся меньше исходного', () => {
    for (const name of files) {
      const text = readFileSync(join(exampleDir, name), 'utf8');
      const out = renderSheet(text);
      ok(out.length > 0, `${name}: проекция пуста`);
      ok(
        Buffer.byteLength(out, 'utf8') <= Buffer.byteLength(text, 'utf8'),
        `${name}: проекция не меньше исходника`,
      );
    }
  });

  it('intent.md: числа приёмочного листа сохранены в проекции', () => {
    const text = readFileSync(join(exampleDir, 'intent.md'), 'utf8');
    const out = renderSheet(text);
    // Литеральные значения задачи — то, что следующий этап обязан увидеть без потери.
    ok(out.includes('claim-1'));
    ok(out.includes('Idempotency-Key'));
    ok(out.includes('200'));
  });

  it('plan.md: шаги и files_to_touch остаются читаемыми', () => {
    const text = readFileSync(join(exampleDir, 'plan.md'), 'utf8');
    const out = renderSheet(text);
    ok(out.includes('IdempotencyGuard'));
    ok(out.includes('PaymentService.java'));
  });
});
