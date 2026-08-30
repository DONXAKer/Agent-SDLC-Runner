/**
 * Разбор артефакта, напечатанного в ответ вместо вызова инструмента.
 *
 * Форма взята из настоящих ответов замеренных моделей (`docs/model-runs.md`, этап 5):
 * заголовок с именем файла, следом блок в тройных кавычках. Проверяется и обратное —
 * что разбор НЕ хватает всё подряд: иначе рантайм начал бы писать файлы по случайным
 * упоминаниям в рассуждениях.
 */

import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { salvageBlocks } from '../src/run/salvage.ts';

const JOURNAL = 'D:/proj/.sdlc/x/chunk-1-journal.md';
const DIFF = 'D:/proj/.sdlc/x/chunk-1-attempt-1-diff.patch';

describe('спасение артефакта из текста ответа', () => {
  it('берёт блок, названный именем артефакта этапа', () => {
    const text = [
      'Конечно! Давайте заполним файлы.',
      '',
      '### Файл `chunk-1-journal.md`',
      '',
      '```',
      '# Журнал chunk’а 1',
      'строка два',
      '```',
      '',
      'Готово.',
    ].join('\n');

    const got = salvageBlocks(text, [JOURNAL, DIFF]);
    deepStrictEqual(
      got.map((b) => b.path),
      [JOURNAL],
    );
    strictEqual(got[0]?.content, '# Журнал chunk’а 1\nстрока два\n');
  });

  it('блок без имени артефакта рядом не берётся', () => {
    const text = ['Вот как примерно выглядит гейт:', '', '```ts', 'const x = 1;', '```'].join('\n');
    deepStrictEqual(salvageBlocks(text, [JOURNAL]), []);
  });

  it('незакрытый блок не берётся: содержимое неполно', () => {
    const text = ['### Файл `chunk-1-journal.md`', '```', '# начало и обрыв'].join('\n');
    deepStrictEqual(salvageBlocks(text, [JOURNAL]), []);
  });

  it('пустой блок содержимым не считается', () => {
    const text = ['### Файл `chunk-1-journal.md`', '```', '', '```'].join('\n');
    deepStrictEqual(salvageBlocks(text, [JOURNAL]), []);
  });

  it('два разных артефакта в одном ответе разбираются оба', () => {
    const text = [
      'Файл `chunk-1-journal.md`:',
      '```',
      'журнал',
      '```',
      '',
      'Файл `chunk-1-attempt-1-diff.patch`:',
      '```',
      'diff --git a/x b/x',
      '```',
    ].join('\n');
    deepStrictEqual(
      salvageBlocks(text, [JOURNAL, DIFF]).map((b) => b.path),
      [JOURNAL, DIFF],
    );
  });

  it('первый блок артефакта побеждает: повтор не затирает найденное', () => {
    const text = [
      'Файл `chunk-1-journal.md`',
      '```',
      'первый',
      '```',
      'Файл `chunk-1-journal.md`',
      '```',
      'второй',
      '```',
    ].join('\n');
    const got = salvageBlocks(text, [JOURNAL]);
    strictEqual(got.length, 1);
    strictEqual(got[0]?.content, 'первый\n');
  });

  it('пустой ответ ничего не даёт', () => {
    deepStrictEqual(salvageBlocks('   ', [JOURNAL]), []);
  });

  // С расширением целей на files_to_touch (этап 5) в списке появляются файлы КОДА —
  // и одноимённые файлы в разных каталогах перестают быть теорией.
  it('код из плана спасается по хвосту пути, одноимённые файлы различаются', () => {
    const A = 'D:/proj/src/index.ts';
    const B = 'D:/proj/test/index.ts';
    const text = ['Файл `src/index.ts`:', '```ts', 'export const a = 1;', '```'].join('\n');
    const got = salvageBlocks(text, [JOURNAL, A, B]);
    deepStrictEqual(
      got.map((b) => b.path),
      [A],
    );
  });

  it('неоднозначное имя без пути не спасается — здесь не гадают', () => {
    const A = 'D:/proj/src/index.ts';
    const B = 'D:/proj/test/index.ts';
    const text = ['Файл `index.ts`:', '```ts', 'export const a = 1;', '```'].join('\n');
    deepStrictEqual(salvageBlocks(text, [A, B]), []);
  });
});
