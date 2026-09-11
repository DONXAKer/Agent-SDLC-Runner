/**
 * Автозаполнение механики отчёта разведки (`run/exploreAutofill.ts`), точечные правки
 * полей (`explore/fields.ts`) и счёт плейсхолдеров без решений человека.
 */

import { ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { countPlaceholdersExceptDecisions, replaceAfterLabel } from '../src/artifacts/artifact.ts';
import { removeTableInSection, replaceTableRows, spliceFieldValue } from '../src/explore/fields.ts';
import { autofillExplorationReport, briefFromIntent, titleFromIntent } from '../src/run/exploreAutofill.ts';

const REPORT = [
  '# Отчёт разведки: ‹название витка›',
  '',
  '> Этап 2. Заполняет агент. `SDLC.md` → этап 2.',
  '',
  '- **Задача:** `intent.md` (‹название витка›) — ‹одно предложение о цели›',
  '- **Гейт «Заполненность артефактов»:** ‹✅/❌ — греп `‹…›` по артефактам этапов 1–2 и обязательные',
  '  секции› / ⏭ — гейт в долге',
  '',
  '## Стек и конвенции',
  '',
  '- Язык / стек: ‹что›',
  '- Сборка / тесты: ‹команды›',
  '- Конвенции: ‹что важно соблюдать›',
  '',
  '## Найдено для переиспользования',
  '_легенда_',
  '',
  '| Символ | Где (`путь:символ`) | Что делает | Как используем |',
  '|---|---|---|---|',
  '| ‹Name› | ‹path/to/file:Name› | ‹что делает› | ‹как используем› |',
  '',
  '_Ничего подходящего не найдено: ‹да / нет — если да, таблицу выше удалить целиком›_',
  '',
  '**Решение человека о полноте:** ‹лист полон / пропуск найден: что именно› — ‹имя›',
  '',
].join('\n');

const stack = [{ dir: '.', label: 'Node.js', build: null, test: 'node --test' }];

describe('факты из задачи', () => {
  it('название и одно предложение цели', () => {
    strictEqual(titleFromIntent('# Задача: Бесплатная доставка\n\n## Коротко\n_легенда_\nВозим крупное бесплатно. Второе предложение.\n'), 'Бесплатная доставка');
    strictEqual(briefFromIntent('# Задача: x\n\n## Коротко\n_легенда_\nВозим крупное бесплатно. Второе предложение.\n\n## Зачем\nz\n'), 'Возим крупное бесплатно.');
    strictEqual(briefFromIntent('# Задача: x\n\n## Коротко\n‹что делаем›\n'), null);
  });
});

describe('автозаполнение отчёта', () => {
  it('название, цель, стек, команды; гейт в долге — ⏭ целиком, включая продолжение строки', () => {
    const { text, filled } = autofillExplorationReport(REPORT, { title: 'Демо', brief: 'Возим бесплатно.', stack, fillednessGate: 'debt' });
    ok(text.startsWith('# Отчёт разведки: Демо'));
    ok(text.includes('- **Задача:** `intent.md` (Демо) — Возим бесплатно.'));
    ok(text.includes('- Язык / стек: Node.js'));
    ok(text.includes('- Сборка / тесты: сборки нет (язык без компиляции); тесты `node --test`'));
    ok(text.includes('- **Гейт «Заполненность артефактов»:** ⏭ — гейт в долге\n'), text);
    ok(!text.includes('секции› / ⏭'), 'хвост меню остался');
    ok(text.includes('- Конвенции: ‹что важно соблюдать›'), 'содержательное поле затронуто');
    strictEqual(filled, 6); // h1, «Задача» (название + цель), стек, команды, гейт
    ok(text.includes('**Решение человека о полноте:** ‹лист полон'), 'решение человека затронуто');
  });

  it('пустая цель («Коротко» не заполнено) — плейсхолдер остаётся, а не стирается пустой строкой', () => {
    const withNull = autofillExplorationReport(REPORT, { title: 'Демо', brief: null, stack, fillednessGate: 'debt' });
    ok(withNull.text.includes('‹одно предложение о цели›'), withNull.text);
    const withEmpty = autofillExplorationReport(REPORT, { title: 'Демо', brief: '', stack, fillednessGate: 'debt' });
    ok(withEmpty.text.includes('‹одно предложение о цели›'), withEmpty.text);
  });

  it('гейт включён — строка остаётся плейсхолдером до конца конвейера', () => {
    const { text } = autofillExplorationReport(REPORT, { title: 'Демо', brief: '', stack: [], fillednessGate: 'enabled' });
    ok(text.includes('‹✅/❌'));
    ok(text.includes('- Язык / стек: ‹что›'), 'без стека поле не сочиняется');
  });

  it('идемпотентно', () => {
    const once = autofillExplorationReport(REPORT, { title: 'Демо', brief: 'Цель.', stack, fillednessGate: 'debt' }).text;
    const twice = autofillExplorationReport(once, { title: 'Демо', brief: 'Цель.', stack, fillednessGate: 'debt' });
    strictEqual(twice.text, once);
    strictEqual(twice.filled, 0);
  });
});

describe('точечные правки полей', () => {
  it('spliceFieldValue меняет ветку меню целиком; отсутствующее поле — null', () => {
    const out = spliceFieldValue(REPORT, 'exploration-report.template.md', 'гейт «заполненность артефактов»', '✅')!;
    ok(out.includes('- **Гейт «Заполненность артефактов»:** ✅\n\n## Стек'), out);
    strictEqual(spliceFieldValue(REPORT, 'exploration-report.template.md', 'нет такого поля', 'x'), null);
  });

  it('removeTableInSection удаляет таблицу и оставляет легенды; replaceTableRows меняет только строки', () => {
    const removed = removeTableInSection(REPORT, /^найдено для переиспользования$/i, '');
    ok(!removed.includes('| Символ |'));
    ok(removed.includes('_Ничего подходящего не найдено:'));
    const rows = replaceTableRows(REPORT, /^найдено для переиспользования$/i, ['| weightStep | src/tariffs.ts:weightStep | ступень | вызываем |']);
    ok(rows.includes('| Символ | Где'));
    ok(rows.includes('| weightStep |'));
    ok(!rows.includes('‹Name›'));
  });

  it('replaceAfterLabel — как setDecision, для любой метки', () => {
    strictEqual(replaceAfterLabel('- **Ветка:** ‹x›\n', 'Ветка', 'sdlc/demo'), '- **Ветка:** sdlc/demo\n');
    strictEqual(replaceAfterLabel('текст без поля', 'Ветка', 'x'), null);
  });
});

describe('плейсхолдеры без решений человека', () => {
  it('строка решения и её продолжение не считаются', () => {
    const text = '- **Итог:** ‹что›\n- **Подтвердил:** ‹имя› ·\n  ‹дата›\n';
    strictEqual(countPlaceholdersExceptDecisions(text), 1);
    strictEqual(countPlaceholdersExceptDecisions('- **Подтвердил:** ‹имя›\n'), 0);
  });
});
