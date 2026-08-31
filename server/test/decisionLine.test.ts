/**
 * Единый словарь меток решений человека: жирные метки полей и подписные колонки таблиц.
 *
 * Контракт из ревью-2: проза со словами решений («приёмка не запускалась» в легендах
 * handoff-бланка) — НЕ поле решения, и машинные плейсхолдеры на таких строках обязаны
 * оставаться доступными автозаполнению и formFill.
 */

import { strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isDecisionCell, isDecisionLine } from '../src/artifacts/artifact.ts';
import { groupFields } from '../src/exec/FormFillExecutor.ts';

describe('isDecisionLine — жирная метка поля, не подстрока', () => {
  it('поля решений матчатся во всех формах шаблонов', () => {
    strictEqual(isDecisionLine('- **Подтвердил:** ‹имя› · ‹дата›'), true);
    strictEqual(isDecisionLine('**Одобрение:** ‹имя и дата›'), true);
    strictEqual(isDecisionLine('- **Приёмка:** ‹имя› · ‹дата›'), true);
    strictEqual(isDecisionLine('**Решение человека о полноте:** ‹…›'), true);
  });

  it('форма handoff «**Кто утвердил** _(пояснение)_:» — поле решения (ревью-3)', () => {
    strictEqual(
      isDecisionLine('- **Кто утвердил** _(только имя из явного ответа человека)_: н/п / ‹имя›'),
      true,
    );
  });

  it('проза со словами решений полем не является', () => {
    // Ревью-2: подстрочный матч отнимал у автозаполнения машинные поля handoff-бланка.
    strictEqual(isDecisionLine('Пункты в `❌`: ‹id› … н/п — **приёмка** не запускалась'), false);
    strictEqual(isDecisionLine('Возвратов: ‹K−1› _(0 = приёмка с первой попытки)_'), false);
    strictEqual(isDecisionLine('модель подтвердила выбор'), false);
    strictEqual(isDecisionLine('- **План:** `plan.md`, одобрение от ‹дата›'), false);
  });
});

describe('isDecisionCell — подписная колонка шапки таблицы', () => {
  it('колонки подписи распознаются по началу ячейки', () => {
    strictEqual(isDecisionCell('Утвердил (человек)'), true);
    strictEqual(isDecisionCell('Кто'), true);
    strictEqual(isDecisionCell('Кто утвердил'), true);
  });

  it('обычные колонки — нет', () => {
    strictEqual(isDecisionCell('Вопрос'), false);
    strictEqual(isDecisionCell('Некто'), false);
    strictEqual(isDecisionCell('Причина'), false);
    // Дефис и цифра — не граница слова (ревью-3).
    strictEqual(isDecisionCell('Кто-то'), false);
    strictEqual(isDecisionCell('Кто2'), false);
  });
});

describe('groupFields на легендах handoff-бланка', () => {
  it('строка-проза с «приёмкой» и плейсхолдером остаётся полем', () => {
    const fields = groupFields('- Пункты в `x`: ‹id или н/п› — приёмка не запускалась\n');
    strictEqual(fields.length, 1);
    strictEqual(fields[0]?.kind, 'cell');
  });

  it('строка-ПРОДОЛЖЕНИЕ поля решения наследует его статус (ревью-4, живой шаблон)', () => {
    // Поле переносится: метка на первой строке, ‹имя› — на второй.
    const text =
      '- **Кто утвердил:** _(только имя из явного ответа человека — не имя\n' +
      '  оператора сессии)_ н/п / ‹имя› /\n' +
      '- **Где реализовано:** ‹путь›\n';
    const fields = groupFields(text);
    strictEqual(fields.length, 1);
    strictEqual(fields[0]?.text, '‹путь›');
  });
});
