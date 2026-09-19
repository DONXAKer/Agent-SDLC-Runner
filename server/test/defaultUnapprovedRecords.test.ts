/**
 * Дефолт-подстановка «Кто утвердил» в записях о проскочившем дефекте (7.4, остаток) —
 * `stages/handoff.ts::defaultUnapprovedRecords`. Фикстуры — по реальной форме шаблона
 * (многострочное поле, перенос значения на вторую-третью строку) — тот же класс формы,
 * что уже ловил `humanDecision.test.ts` на живом шаблоне.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadConfig } from '../src/config/load.ts';
import { defaultUnapprovedRecords } from '../src/run/stages/handoff.ts';

// Путь к эталону — из конфига, а не зашит машинно (регрессия ревью, 2026-09-19): хардкод
// `D:/Проекты/agent-sdlc/...` был верен только на одной машине и без пропуска красил бы
// набор на любой другой (тот же приём, что уже применяет `formAutofill.test.ts`).
const templatePath = join(loadConfig().runner.methodologyDir, 'templates', 'handoff.template.md');
const noTemplate = existsSync(templatePath) ? false : 'эталон методологии недоступен (SDLC_METHODOLOGY_DIR)';

/** Один «доведённый до конца» блок записи — все поля решены, кроме «Кто утвердил». */
const COMPLETE_RECORD = [
  '### Запись 1',
  '',
  '- **Имя:** дублирующийся заказ при повторном клике',
  '- **Класс**: класс «двойной сабмит формы»',
  '- **Повтор:** нет',
  '- **Что проскочило:** повторный клик на «Оформить» создавал два заказа',
  '- **Какой гейт должен был поймать и почему не поймал:** Тесты — не покрывает класс',
  '- **Действие**: проверка',
  '- **Кто утвердил:** _(только имя из явного ответа человека на вопрос об этой записи — не имя',
  '  оператора сессии по умолчанию и не имя из более раннего одобрения витка)_ н/п / ‹имя› /',
  '  **(не утверждено — классификация агента по умолчанию)** — вопрос был пропущен или без ответа',
  '- **Где реализовано:** src/checkout.ts:submitOrder — добавлен debounce',
  '- **Чем закреплено**: test/checkout.test.ts::«двойной сабмит»',
].join('\n');

const NO_DEFECTS_RECORD = [
  '### Запись 1',
  '',
  '- **Имя:** нет',
  '- **Класс**: н/п',
  '- **Повтор:** н/п',
  '- **Что проскочило:** н/п',
  '- **Какой гейт должен был поймать и почему не поймал:** н/п',
  '- **Действие**: н/п',
  '- **Кто утвердил:** _(только имя из явного ответа человека на вопрос об этой записи — не имя',
  '  оператора сессии по умолчанию и не имя из более раннего одобрения витка)_ н/п / ‹имя› /',
  '  **(не утверждено — классификация агента по умолчанию)** — вопрос был пропущен или без ответа',
  '- **Где реализовано:** н/п',
  '- **Чем закреплено**: н/п',
].join('\n');

/** Ещё черновая запись: «Класс» и «Действие» всё ещё плейсхолдеры — рано подставлять дефолт. */
const DRAFT_RECORD = [
  '### Запись 1',
  '',
  '- **Имя:** дублирующийся заказ при повторном клике',
  '- **Класс**: ‹короткая строка-идентификатор класса отказа›',
  '- **Повтор:** н/п',
  '- **Что проскочило:** повторный клик создавал два заказа',
  '- **Какой гейт должен был поймать и почему не поймал:** н/п',
  '- **Действие**: н/п / конструкция / проверка / принятие риска',
  '- **Кто утвердил:** _(только имя из явного ответа человека на вопрос об этой записи — не имя',
  '  оператора сессии по умолчанию и не имя из более раннего одобрения витка)_ н/п / ‹имя› /',
  '  **(не утверждено — классификация агента по умолчанию)** — вопрос был пропущен или без ответа',
  '- **Где реализовано:** н/п',
  '- **Чем закреплено**: н/п',
].join('\n');

function doc(...records: string[]): string {
  return [
    '# Передача контекста: demo',
    '',
    '## Запись о проскочившем дефекте',
    '',
    '_легенда_',
    '',
    ...records,
    '',
  ].join('\n');
}

describe('defaultUnapprovedRecords (7.4, остаток)', () => {
  it('запись доведена до конца, «Кто утвердил» не решено — подставляет дефолт', () => {
    const { text, repaired } = defaultUnapprovedRecords(doc(COMPLETE_RECORD));
    strictEqual(repaired, 1);
    ok(text.includes('**Кто утвердил:** **(не утверждено — классификация агента по умолчанию)** — вопрос был пропущен или без ответа'), text);
    ok(!text.includes('‹имя›'), text);
    // Соседние поля не задеты.
    ok(text.includes('src/checkout.ts:submitOrder'), text);
    ok(text.includes('test/checkout.test.ts::«двойной сабмит»'), text);
  });

  it('«Имя: нет» (дефектов не было) — не трогается, н/п законен', () => {
    const { text, repaired } = defaultUnapprovedRecords(doc(NO_DEFECTS_RECORD));
    strictEqual(repaired, 0);
    strictEqual(text, doc(NO_DEFECTS_RECORD));
  });

  it('«Имя: нет.» (с точкой) — тоже законная форма «дефектов не было», не трогается', () => {
    // Регрессия ревью (2026-09-19): точка/запятая после «нет» — обычная человеческая
    // пунктуация, а не признак реального дефекта. Без нормализации запись проходила ВСЕ
    // защитные проверки и получала дефолт «Кто утвердил» вопреки собственному инварианту
    // функции («Имя: нет» не трогается).
    const withPeriod = NO_DEFECTS_RECORD.replace('- **Имя:** нет', '- **Имя:** нет.');
    const { text, repaired } = defaultUnapprovedRecords(doc(withPeriod));
    strictEqual(repaired, 0);
    strictEqual(text, doc(withPeriod));
  });

  it('«Имя: нет,» (с запятой) — тоже законная форма, не трогается', () => {
    const withComma = NO_DEFECTS_RECORD.replace('- **Имя:** нет', '- **Имя:** нет,');
    const { text, repaired } = defaultUnapprovedRecords(doc(withComma));
    strictEqual(repaired, 0);
    strictEqual(text, doc(withComma));
  });

  it('запись ещё черновая (другие поля не решены) — рано подставлять дефолт', () => {
    const { text, repaired } = defaultUnapprovedRecords(doc(DRAFT_RECORD));
    strictEqual(repaired, 0);
    strictEqual(text, doc(DRAFT_RECORD));
  });

  it('«Кто утвердил» уже решено настоящим именем — не трогается', () => {
    const withName = COMPLETE_RECORD.replace(
      /- \*\*Кто утвердил:\*\*[\s\S]*?вопрос был пропущен или без ответа/,
      '- **Кто утвердил:** Иван Петров · 2026-09-18',
    );
    const { text, repaired } = defaultUnapprovedRecords(doc(withName));
    strictEqual(repaired, 0);
    ok(text.includes('Иван Петров'), text);
  });

  it('идемпотентно: повторный вызов на уже подставленном дефолте не дублирует текст', () => {
    const once = defaultUnapprovedRecords(doc(COMPLETE_RECORD)).text;
    const twice = defaultUnapprovedRecords(once);
    strictEqual(twice.repaired, 0);
    strictEqual(twice.text, once);
  });

  it('несколько записей — репарируется только доведённая до конца', () => {
    const draft2 = DRAFT_RECORD.replace('### Запись 1', '### Запись 2');
    const complete2 = COMPLETE_RECORD.replace('### Запись 1', '### Запись 3').replace(
      'дублирующийся заказ при повторном клике',
      'протечка секрета в логах',
    );
    const { text, repaired } = defaultUnapprovedRecords(doc(COMPLETE_RECORD, draft2, complete2));
    strictEqual(repaired, 2);
    ok(text.includes('протечка секрета в логах'), text);
    // Запись 2 (черновая) осталась нетронутой.
    ok(text.includes('### Запись 2'), text);
    const idx2 = text.indexOf('### Запись 2');
    const idx3 = text.indexOf('### Запись 3');
    const block2 = text.slice(idx2, idx3);
    ok(block2.includes('‹имя›'), 'черновая запись 2 не должна получить дефолт');
  });

  it('секции «Запись о проскочившем дефекте» нет — no-op, не падение', () => {
    const noSection = '# Передача\nбез секции\n';
    const { text, repaired } = defaultUnapprovedRecords(noSection);
    strictEqual(repaired, 0);
    strictEqual(text, noSection);
  });

  it('живой шаблон методологии: чистый бланк (все поля ещё плейсхолдеры) — не трогается', { skip: noTemplate }, () => {
    const tpl = readFileSync(templatePath, 'utf8');
    const { repaired } = defaultUnapprovedRecords(tpl);
    strictEqual(repaired, 0);
  });

  it('живой шаблон методологии: запись, доведённая до конца, репарируется корректно', { skip: noTemplate }, () => {
    // Заполняем ВСЕ плейсхолдеры записи генерически, кроме поля «Кто утвердил» (его
    // трёхстрочный блок вырезается перед заливкой и возвращается на место как есть) —
    // устойчиво к правкам формулировок шаблона, в отличие от ручного посимвольного
    // воспроизведения каждой строки.
    const tpl = readFileSync(templatePath, 'utf8');
    const ktoStart = tpl.indexOf('- **Кто утвердил:**');
    ok(ktoStart >= 0, 'поле «Кто утвердил» обязано быть в живом шаблоне');
    const ktoEnd = tpl.indexOf('- **Где реализовано:**', ktoStart);
    ok(ktoEnd > ktoStart, 'поле «Где реализовано» обязано идти сразу после «Кто утвердил»');
    const ktoBlock = tpl.slice(ktoStart, ktoEnd);

    // «Имя» — отдельно и ПЕРВЫМ: заменяется вся альтернатива «нет / ‹…›», а не только
    // плейсхолдер внутри нeё, иначе строка остаётся «нет / протечка …» — с ведущим «нет»,
    // который `defaultUnapprovedRecords` честно читает как «дефектов не было».
    const beforeRaw = tpl
      .slice(0, ktoStart)
      .replace('нет / ‹три-четыре слова, по которым запись узнаётся выше и в следующих передачах›', 'протечка секрета в логах');
    const before = beforeRaw.replace(/‹[^‹›\n]*(?:\n\s*[^‹›\n]*)*?›/g, 'заполнено');
    const after = tpl.slice(ktoEnd).replace(/‹[^‹›\n]*(?:\n\s*[^‹›\n]*)*?›/g, 'заполнено');
    const filled = before + ktoBlock + after;

    ok(!/‹[^›]*›/.test(before), 'в части до «Кто утвердил» не должно остаться плейсхолдеров');
    ok(!/‹[^›]*›/.test(after), 'в части после «Кто утвердил» не должно остаться плейсхолдеров');

    const { text, repaired } = defaultUnapprovedRecords(filled);
    strictEqual(repaired, 1);
    ok(text.includes(DEFAULT_LOOKUP), text);
  });
});

const DEFAULT_LOOKUP = '**(не утверждено — классификация агента по умолчанию)**';
