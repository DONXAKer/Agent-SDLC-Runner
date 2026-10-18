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

// Живой прогон s2 (2026-09-25, `gpt-oss-20b`): журнал chunk'а разложен из эталона с
// `core.autocrlf=true` — CRLF, а модель шлёт многострочный `old_string` через `\n` и с
// `replace_all: true`, при котором мягкий поиск не включается. 9 промахов подряд, ход сгорел.
describe('adaptEol: правка с `\n` против файла с `\r\n`', () => {
  const JOURNAL =
    '## Место правки\r\n\r\n' +
    '- Точки правки по итогам точечной разведки: ‹файл:символ, …›\r\n' +
    '- Карта разведки: совпала / разошлась — ‹что именно; расхождение = возврат на план›\r\n\r\n' +
    '- **Подтвердил:** ‹имя› · ‹дата›\r\n';
  const OLD =
    '- Точки правки по итогам точечной разведки: ‹файл:символ, …›\n' +
    '- Карта разведки: совпала / разошлась — ‹что именно; расхождение = возврат на план›';
  const NEW = '- Точки правки по итогам точечной разведки: src/vat.ts:rate\n- Карта разведки: совпала';

  it('с replace_all — применяется, файл сохраняет CRLF и не получает смешанных окончаний', () => {
    const out = applyEdits(JOURNAL, [{ oldStr: OLD, newStr: NEW, replaceAll: true }]);
    strictEqual(out.includes('src/vat.ts:rate\r\n- Карта разведки: совпала\r\n'), true);
    strictEqual(/[^\r]\n/.test(out), false);
  });

  it('без replace_all — то же (дословно после перевода, до мягкого поиска)', () => {
    const out = applyEdits(JOURNAL, [{ oldStr: OLD, newStr: NEW, replaceAll: false }]);
    strictEqual(/[^\r]\n/.test(out), false);
    strictEqual(out.includes('‹файл:символ, …›'), false);
  });

  it('инструмент Edit loop-флоу применяет её так же, как предпросмотр', async () => {
    const { mkdtempSync, readFileSync, rmSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const { executeTool } = await import('../src/exec/tools/index.ts');
    const root = mkdtempSync(join(tmpdir(), 'sdlc-crlf-'));
    try {
      writeFileSync(join(root, 'j.md'), JOURNAL);
      const r = await executeTool(
        { kind: 'edit', path: 'j.md', edits: [{ oldStr: OLD, newStr: NEW, replaceAll: true }] },
        { projectRoot: root, maxResultBytes: 100_000, signal: new AbortController().signal } as never,
      );
      strictEqual(r.ok, true, r.text);
      strictEqual(readFileSync(join(root, 'j.md'), 'utf8'), applyEdits(JOURNAL, [{ oldStr: OLD, newStr: NEW, replaceAll: true }]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('смешанные окончания: фрагмент из LF-части правится как есть, без перевода', () => {
    const mixed = 'a\r\nb\r\n' + 'x\ny\n';
    strictEqual(applyEdits(mixed, [{ oldStr: 'x\ny', newStr: 'X\nY', replaceAll: false }]), 'a\r\nb\r\nX\nY\n');
  });

  it('LF-файл не трогается', () => {
    strictEqual(applyEdits('p\nq\n', [{ oldStr: 'p\nq', newStr: 'P\nQ', replaceAll: true }]), 'P\nQ\n');
  });
});
