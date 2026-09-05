/**
 * Промах `Edit` по перенесённой строке шаблона.
 *
 * Замер 2026-09-04 (`polza:ministral-14b`, 14 семейств фикстур): модель шлёт шаблонную
 * строку В ОДНУ СТРОКУ, а в файле она перенесена, — и промахивается по одному и тому же
 * месту 5–6 раз подряд, пока анти-цикл не гасит этап. Здесь проверяется, что запасной путь
 * снимает ровно этот класс и не расширяет `Edit` ни на что другое.
 */

import { deepStrictEqual, strictEqual, throws } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { findLooseRange } from '../src/exec/editMatch.ts';
import { applyEdits, EditApplyError } from '../src/approval/preview.ts';

/** Настоящая строка шаблона отчёта разведки эталона — с переносом внутри плейсхолдера. */
const WRAPPED =
  '## Стек и конвенции\n' +
  '- Требования к окружению прогона: ‹что должно быть доступно, чтобы тесты этапа 6 запустились —\n' +
  '  Docker, база, сеть; проверено ли это здесь› / ничего особенного\n';

/** Та же строка, какой её присылает модель: перенос склеен пробелом. */
const JOINED =
  '- Требования к окружению прогона: ‹что должно быть доступно, чтобы тесты этапа 6 запустились — ' +
  'Docker, база, сеть; проверено ли это здесь› / ничего особенного';

describe('findLooseRange', () => {
  it('склеенный моделью перенос находит место в файле', () => {
    const r = findLooseRange(WRAPPED, JOINED);
    strictEqual(typeof r, 'object');
    if (typeof r !== 'object') return;
    strictEqual(WRAPPED.slice(r.start, r.end).includes('\n  Docker'), true, 'взят перенос из файла');
  });

  it('фрагмента нет вовсе — «none», мягкий поиск не выдумывает место', () => {
    strictEqual(findLooseRange(WRAPPED, '- Такой строки в файле нет: ‹что›'), 'none');
  });

  it('два подходящих места — «ambiguous», а не выбор наугад', () => {
    const twice = 'a b\nсерединка\na  b\n';
    strictEqual(findLooseRange(twice, 'a b'), 'ambiguous');
  });

  it('фрагмент без пробелов мягкому поиску не отдаётся: дословный уже отработал', () => {
    strictEqual(findLooseRange('xyz', 'xyz'), 'none');
  });

  it('спецсимволы регулярок в тексте берутся буквально', () => {
    // Без экранирования `.` и `(` разбирались бы как синтаксис и совпадали не с тем.
    const text = 'if (a.b) {\n  go();\n}\n';
    const r = findLooseRange(text, 'if (a.b) { go(); }');
    strictEqual(typeof r, 'object');
    strictEqual(findLooseRange(text, 'if (aXb) { go(); }'), 'none');
  });
});

describe('applyEdits: предпросмотр применяет правку так же, как инструмент', () => {
  it('перенесённая строка заменяется, на диск идёт new_string модели', () => {
    const out = applyEdits(WRAPPED, [
      { oldStr: JOINED, newStr: '- Требования к окружению прогона: ничего особенного', replaceAll: false },
    ]);
    strictEqual(out.includes('ничего особенного'), true);
    strictEqual(out.includes('‹что должно быть доступно'), false, 'плейсхолдер обязан исчезнуть целиком');
    strictEqual(out.startsWith('## Стек и конвенции\n'), true, 'соседний текст не тронут');
  });

  it('дословное совпадение по-прежнему выигрывает и ничего не сдвигает', () => {
    const src = 'раз\nдва\nтри\n';
    strictEqual(applyEdits(src, [{ oldStr: 'два', newStr: 'ДВА', replaceAll: false }]), 'раз\nДВА\nтри\n');
  });

  it('несуществующий фрагмент остаётся ошибкой', () => {
    throws(() => applyEdits(WRAPPED, [{ oldStr: 'нет такого текста тут', newStr: 'x', replaceAll: false }]), EditApplyError);
  });

  it('неоднозначное мягкое совпадение — ошибка, а не запись наугад', () => {
    // Дословно «a b» здесь не встречается ни разу (в файле два пробела и табуляция), а
    // мягко подходят оба места — выбирать наугад нельзя.
    throws(
      () => applyEdits('a  b\nx\na\tb\n', [{ oldStr: 'a b', newStr: 'y', replaceAll: false }]),
      EditApplyError,
    );
  });
});

describe('границы: мягкий поиск не размывает контракт Edit', () => {
  it('пустой old_string остаётся ошибкой', () => {
    throws(() => applyEdits('текст', [{ oldStr: '', newStr: 'x', replaceAll: false }]), EditApplyError);
  });

  it('replace_all мягкого пути не получает: массовая замена по догадке опаснее отказа', () => {
    deepStrictEqual(findLooseRange(WRAPPED, JOINED) === 'none', false);
    throws(
      () => applyEdits(WRAPPED, [{ oldStr: JOINED, newStr: 'x', replaceAll: true }]),
      EditApplyError,
    );
  });
});
