/**
 * Разбор markdown для дашборда: артефакты методологии, промпт и ответ модели. Компонент
 * рисует дерево как есть — всё решающее здесь.
 */

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isMarkdownName, parseInline, parseMarkdown, splitRow } from '../src/lib/markdown.ts';
import type { Block } from '../src/lib/markdown.ts';

const kinds = (blocks: Block[]): string[] => blocks.map((b) => b.t);

describe('parseInline', () => {
  it('код, жирный, курсив, зачёркнутый, ссылка, плейсхолдер', () => {
    deepStrictEqual(parseInline('a `x|y` **b** *c* ~~d~~ [e](https://e.ru) ‹f›'), [
      { t: 'text', v: 'a ' },
      { t: 'code', v: 'x|y' },
      { t: 'text', v: ' ' },
      { t: 'strong', c: [{ t: 'text', v: 'b' }] },
      { t: 'text', v: ' ' },
      { t: 'em', c: [{ t: 'text', v: 'c' }] },
      { t: 'text', v: ' ' },
      { t: 'del', c: [{ t: 'text', v: 'd' }] },
      { t: 'text', v: ' ' },
      { t: 'link', c: [{ t: 'text', v: 'e' }], href: 'https://e.ru' },
      { t: 'text', v: ' ' },
      { t: 'ph', v: '‹f›' },
    ]);
  });

  it('подчёркивание внутри идентификатора курсивом не считается', () => {
    deepStrictEqual(parseInline('files_to_touch и chunk_1_attempt'), [{ t: 'text', v: 'files_to_touch и chunk_1_attempt' }]);
    deepStrictEqual(parseInline('_важно_'), [{ t: 'em', c: [{ t: 'text', v: 'важно' }] }]);
  });

  it('код, перенесённый на следующую строку, остаётся одним кодом', () => {
    deepStrictEqual(parseInline('`git ls-files\n--others` исключает .gitignore`ом'), [
      { t: 'code', v: 'git ls-files\n--others' },
      { t: 'text', v: ' исключает .gitignore`ом' },
    ]);
  });

  it('незакрытая разметка остаётся текстом', () => {
    deepStrictEqual(parseInline('2 * 3 и **без пары'), [{ t: 'text', v: '2 * 3 и **без пары' }]);
  });
});

describe('splitRow', () => {
  it('экранированный разделитель и разделитель в коде — часть ячейки', () => {
    deepStrictEqual(splitRow('| a \\| b | `x | y` | c |'), ['a | b', '`x | y`', 'c']);
  });
});

describe('parseMarkdown', () => {
  it('заголовки, абзац с сохранённым переносом, черта', () => {
    const b = parseMarkdown('# Задача\n\nстрока 1\nстрока 2\n\n---\n## Итог');
    deepStrictEqual(kinds(b), ['heading', 'para', 'hr', 'heading']);
    deepStrictEqual(b[1], { t: 'para', c: [{ t: 'text', v: 'строка 1\nстрока 2' }] });
  });

  it('таблица с выравниванием и короткой строкой', () => {
    const [t] = parseMarkdown('| Гейт | Статус |\n|:---|---:|\n| Сборка | ✅ |\n| Тесты |');
    ok(t !== undefined && t.t === 'table');
    deepStrictEqual(t.align, ['left', 'right']);
    strictEqual(t.rows.length, 2);
    deepStrictEqual(t.rows[1], [[{ t: 'text', v: 'Тесты' }], []]);
  });

  it('список: вложенность, номера, чек-боксы, продолжение пункта', () => {
    const [l] = parseMarkdown('- [x] готово\n- [ ] нет\n  1. вложенный\n     продолжение\n- третий');
    ok(l !== undefined && l.t === 'list');
    deepStrictEqual(
      l.items.map((i) => [i.depth, i.num, i.checked]),
      [
        [0, null, true],
        [0, null, false],
        [1, '1', null],
        [0, null, null],
      ],
    );
    deepStrictEqual(l.items[2]!.text, [{ t: 'text', v: 'вложенный\nпродолжение' }]);
  });

  it('код сохраняется дословно, markdown-блок разбирается', () => {
    const b = parseMarkdown('```ts\nconst a = `**x**`;\n```\n\n```markdown\n# Внутри\n- пункт\n```');
    deepStrictEqual(b[0], { t: 'code', lang: 'ts', v: 'const a = `**x**`;' });
    const nested = b[1];
    ok(nested !== undefined && nested.t === 'nested');
    deepStrictEqual(kinds(nested.blocks), ['heading', 'list']);
  });

  it('незакрытый блок кода идёт до конца текста', () => {
    deepStrictEqual(parseMarkdown('```\nа\nб'), [{ t: 'code', lang: '', v: 'а\nб' }]);
  });

  it('цитата, комментарий шаблона, шапка YAML', () => {
    const b = parseMarkdown('---\nslug: x\n---\n> цитата\n> **жирная**\n\n<!-- подсказка\nв две строки -->\nтекст');
    deepStrictEqual(kinds(b), ['code', 'quote', 'comment', 'para']);
    deepStrictEqual(b[0], { t: 'code', lang: 'yaml', v: 'slug: x' });
    deepStrictEqual(b[2], { t: 'comment', v: 'подсказка\nв две строки' });
  });

  it('абзац прерывается таблицей и списком без пустой строки', () => {
    deepStrictEqual(kinds(parseMarkdown('текст\n| a | b |\n|---|---|\n| 1 | 2 |\nтекст\n- пункт')), ['para', 'table', 'para', 'list']);
  });

  it('CRLF не ломает разбор', () => {
    deepStrictEqual(kinds(parseMarkdown('# A\r\n\r\n- b\r\n')), ['heading', 'list']);
  });
});

describe('isMarkdownName', () => {
  it('по расширению', () => {
    ok(isMarkdownName('plan.md'));
    ok(isMarkdownName('.runner/iterations.md'));
    ok(!isMarkdownName('chunk-1-attempt-1.patch'));
    ok(!isMarkdownName('progress.log'));
  });
});
