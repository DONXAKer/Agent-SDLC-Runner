/**
 * Скрытые тесты семейства notify — общий интерпретатор эталона.
 *
 * Кейс `bench/expected/<slug>.json` описывает один сценарий на СВЕЖЕМ стенде (журнал
 * очищен `resetLog()`, транспорт — новый `memoryTransport()` за шпионом, записывающим
 * выданные им id) и набор ожиданий по его итогу. Сценарий — ровно одно из полей:
 *  - `sends: [{ msg, opts? }]` — последовательные `sendNotification(transport, msg[, opts])`;
 *    без `opts` вызов идёт ДВУМЯ аргументами — так проверяется, что прежний контракт жив;
 *    исключение шага ловится и запоминается, остальные шаги идут дальше;
 *  - `outbox: [msg]` — `createOutbox()`, `enqueue` каждого, один `drain(transport)`;
 *  - `log: [entry]` — `logEvent` каждой строки;
 *  - `priorityOf: [msg]` — вызов `priorityOf` на каждом (silent-partial, подзадача 1);
 *  - `constant: "ИМЯ"` — чтение экспорта index.ts по имени (silent-partial, подзадача 4).
 *
 * Ожидания (`expect`) проверяются только те, что перечислены:
 *  - `sentCount`, `sentTo[]`, `sentTexts[]`, `sentPhones[]` (null = поля нет) — по `sent` транспорта;
 *  - `idsFromTransport: true` — каждый возвращённый id совпал с id, выданным транспортом на
 *    той же по счёту отправке (отправитель пробрасывает id, а не выдумывает свой);
 *  - `distinctIds` — число различных возвращённых id (идемпотентность: два вызова — один id);
 *  - `throwsAt` — номер шага `sends` (с единицы), который обязан бросить; остальные — нет;
 *  - `events[]` — журнал целиком; `eventsNonEmpty: true` — в журнале есть хоть что-то;
 *  - `eventsMustContain[]` / `eventsMustNotContain[]` — строка (подстрока хотя бы одной /
 *    ни одной записи) либо `{ regex, flags? }`;
 *  - `priorities[]` — результат `priorityOf` по порядку; `value` — значение константы.
 *
 * Живёт в `lib/`, а не рядом с `<slug>.hidden.mjs`: файл с суффиксом `.hidden.mjs` читается
 * как тест задачи, а этот без BENCH_EXPECTED_SLUG падает — глоб по каталогу давал бы красный
 * «тест» без задачи. Обёртки задач выставляют слаг и импортируют раннер. Импортируется только
 * `src/index.ts` цели: имена новых модулей модели не угадываются.
 */

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { caseLabel, exportOf, importIndex, readExpected, targetDir } from './target.mjs';

const SLUG = process.env.BENCH_EXPECTED_SLUG;
if (SLUG === undefined || SLUG === '') {
  throw new Error('BENCH_EXPECTED_SLUG не задан: hidden-раннеру семейства нужно имя эталона');
}

const TARGET_DIR = targetDir('notify');
const expected = readExpected(SLUG);
const mod = await importIndex(TARGET_DIR);

/** Транспорт-шпион поверх памятного: помнит id, которые сам выдал, — чтобы сверить их с возвращёнными. */
function spyTransport() {
  const inner = exportOf(mod, 'memoryTransport')();
  const issued = [];
  return {
    sent: inner.sent,
    issued,
    send(msg) {
      const id = inner.send(msg);
      issued.push(id);
      return id;
    },
  };
}

function matcher(m) {
  if (typeof m === 'string') return { test: (s) => s.includes(m), show: JSON.stringify(m) };
  const re = new RegExp(m.regex, m.flags ?? 'u');
  return { test: (s) => re.test(s), show: `/${m.regex}/${m.flags ?? 'u'}` };
}

/** Прогон сценария; возвращает всё, что могут спросить ожидания. */
function runScenario(c) {
  const result = { transport: null, returnedIds: [], thrownAt: [], priorities: null, value: undefined };

  // Журнал общий на процесс — чистится перед каждым сценарием, иначе записи одного кейса
  // читались бы в другом и «маска есть» доказывалось бы чужой строкой.
  if (c.log !== undefined || c.sends !== undefined || c.outbox !== undefined) exportOf(mod, 'resetLog')();

  if (c.sends !== undefined) {
    const send = exportOf(mod, 'sendNotification');
    const t = spyTransport();
    result.transport = t;
    c.sends.forEach((step, i) => {
      try {
        const r = step.opts === undefined ? send(t, step.msg) : send(t, step.msg, step.opts);
        result.returnedIds.push(r.id);
      } catch {
        result.thrownAt.push(i + 1);
      }
    });
    return result;
  }

  if (c.outbox !== undefined) {
    const box = exportOf(mod, 'createOutbox')();
    const t = spyTransport();
    result.transport = t;
    for (const msg of c.outbox) box.enqueue(msg);
    result.returnedIds = box.drain(t);
    return result;
  }

  if (c.log !== undefined) {
    const logEvent = exportOf(mod, 'logEvent');
    for (const entry of c.log) logEvent(entry);
    return result;
  }

  if (c.priorityOf !== undefined) {
    const priorityOf = exportOf(mod, 'priorityOf');
    result.priorities = c.priorityOf.map((msg) => priorityOf(msg));
    return result;
  }

  if (c.constant !== undefined) {
    result.value = mod[c.constant];
    return result;
  }

  throw new Error(`кейс ${c.id}: не задан сценарий (sends/outbox/log/priorityOf/constant)`);
}

describe(`скрытые тесты ${SLUG} (цель: ${TARGET_DIR})`, () => {
  for (const c of expected.cases) {
    it(caseLabel(c), () => {
      const r = runScenario(c);
      const e = c.expect;
      const sent = r.transport?.sent ?? [];

      if (e.sentCount !== undefined) strictEqual(sent.length, e.sentCount, 'число отправок в транспорт');
      if (e.sentTo !== undefined) deepStrictEqual(sent.map((m) => m.to), e.sentTo, 'адресаты по порядку отправки');
      if (e.sentTexts !== undefined) deepStrictEqual(sent.map((m) => m.text), e.sentTexts, 'тексты по порядку отправки');
      if (e.sentPhones !== undefined) {
        deepStrictEqual(sent.map((m) => (m.phone === undefined ? null : m.phone)), e.sentPhones, 'телефоны по порядку отправки');
      }
      if (e.idsFromTransport === true) {
        deepStrictEqual(r.returnedIds, r.transport.issued, 'возвращённые id обязаны быть теми, что выдал транспорт');
      }
      if (e.distinctIds !== undefined) strictEqual(new Set(r.returnedIds).size, e.distinctIds, 'число различных id');
      if (e.throwsAt !== undefined) {
        deepStrictEqual(r.thrownAt, [e.throwsAt], `бросить обязан ровно шаг ${e.throwsAt}`);
      } else if (r.thrownAt.length > 0) {
        throw new Error(`шаги ${r.thrownAt.join(', ')} бросили исключение, а кейс этого не ждёт`);
      }

      if (e.events !== undefined || e.eventsNonEmpty === true || e.eventsMustContain !== undefined || e.eventsMustNotContain !== undefined) {
        const events = exportOf(mod, 'events')();
        if (e.events !== undefined) deepStrictEqual([...events], e.events, 'журнал целиком');
        if (e.eventsNonEmpty === true) ok(events.length > 0, 'в журнале обязана быть запись о событии, а журнал пуст');
        for (const m of e.eventsMustContain ?? []) {
          const k = matcher(m);
          ok(events.some((s) => k.test(s)), `ни одна запись журнала не содержит ${k.show}; журнал: ${JSON.stringify(events)}`);
        }
        for (const m of e.eventsMustNotContain ?? []) {
          const k = matcher(m);
          const hit = events.find((s) => k.test(s));
          ok(hit === undefined, `запись журнала содержит запрещённое ${k.show}: ${JSON.stringify(hit)}`);
        }
      }

      if (e.priorities !== undefined) deepStrictEqual(r.priorities, e.priorities, 'priorityOf по порядку');
      if (e.value !== undefined) strictEqual(r.value, e.value, `значение экспорта ${c.constant}`);
    });
  }
});
