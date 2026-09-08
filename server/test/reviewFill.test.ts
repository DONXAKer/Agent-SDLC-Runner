/**
 * Ревью по хункам (`run/reviewFill.ts`): конвейер закрытых вопросов вместо свободного
 * хода рецензента.
 *
 * Меряется одно: находки конвейера обязаны быть теми же записями `record_finding`,
 * которые принимает `acceptRecord` и рисует `renderRecords`, — иначе вердикт их не увидит.
 * Плюс граница шума: «нет» — штатный ответ и находкой не становится, а строка без
 * секции из четырёх выбрасывается, а не превращается в пятую.
 */

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ChatProvider, ChatRequest } from '../src/provider/ChatProvider.ts';
import {
  isNoAnswer,
  parseAxisAnswer,
  parseFindingAnswer,
  reviewByHunks,
  sliceHunks,
} from '../src/run/reviewFill.ts';
import { splitHunks } from '../src/run/claimEvidence.ts';

const DIFF = [
  'diff --git a/src/tariffs.ts b/src/tariffs.ts',
  '--- a/src/tariffs.ts',
  '+++ b/src/tariffs.ts',
  '@@ -10,3 +10,4 @@ export function priceFor(order: Order) {',
  '   const base = zoneBase(order);',
  '+  const extra = Number(process.env.TARIFF_ZONE_EXTRA);',
  '   return base;',
  ' }',
  'diff --git a/test/oversize.test.ts b/test/oversize.test.ts',
  '--- a/test/oversize.test.ts',
  '+++ b/test/oversize.test.ts',
  '@@ -1,2 +1,4 @@',
  '+it("надбавка", () => strictEqual(q.total, q.total));',
  '',
].join('\n');

/** Провайдер: по очереди отдаёт заготовленные ответы; помнит, что его спрашивали. */
function scripted(answers: string[]): ChatProvider & { asked: string[] } {
  const asked: string[] = [];
  return {
    name: 'stub',
    asked,
    async chat(req: ChatRequest) {
      asked.push(req.messages.filter((m) => m.role === 'user').at(-1)?.content ?? '');
      const text = answers.shift() ?? 'нет';
      return {
        text,
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, durationMs: 1, envBlocked: false },
        finishReason: 'end_turn' as const,
      };
    },
  } as unknown as ChatProvider & { asked: string[] };
}

describe('разбор ответа по фрагменту', () => {
  it('строка «секция | текст | место» становится записью record_finding', () => {
    const calls = parseFindingAnswer('review | чтение TARIFF_ZONE_EXTRA без умолчания | src/tariffs.ts:11', 'src/tariffs.ts');
    strictEqual(calls.length, 1);
    deepStrictEqual(calls[0], {
      kind: 'record_finding',
      section: 'review',
      text: 'чтение TARIFF_ZONE_EXTRA без умолчания',
      evidence: 'src/tariffs.ts:11',
    });
  });

  it('«нет» в любой форме — не находка', () => {
    ok(isNoAnswer('нет'));
    ok(isNoAnswer('Нет.'));
    ok(isNoAnswer('```\nнет\n```'));
    deepStrictEqual(parseFindingAnswer('нет', 'a.ts'), []);
  });

  it('русские имена секций приводятся к канону, пятая секция выбрасывается', () => {
    const calls = parseFindingAnswer(
      ['- регрессия | сломан экспорт moveHold | src/booking.ts:40', 'мысли | кажется, что-то не так | x.ts'].join('\n'),
      'src/booking.ts',
    );
    strictEqual(calls.length, 1);
    strictEqual(calls[0]!.kind === 'record_finding' && calls[0]!.section, 'regression');
  });

  it('строка без места получает файл фрагмента — модель видела только его', () => {
    const calls = parseFindingAnswer('scope | правка вне задачи', 'src/tariffs.ts');
    strictEqual(calls[0]!.kind === 'record_finding' && calls[0]!.evidence, 'src/tariffs.ts');
  });
});

describe('разбор ответа по оси', () => {
  it('незатронутая ось: «да | что | место» — расхождение с именем оси в тексте', () => {
    const call = parseAxisAnswer('Настройки', 'да | читается TARIFF_ZONE_EXTRA | src/tariffs.ts:11', 'src/tariffs.ts', false);
    ok(call !== null && call.kind === 'record_finding');
    ok(call.text.includes('«Настройки»'), call.text);
    ok(call.text.includes('TARIFF_ZONE_EXTRA'));
    ok(call.text.includes('не затронутой'), call.text);
    strictEqual(call.evidence, 'src/tariffs.ts:11');
  });

  it('затронутая ось: тот же формат ответа даёт другой текст — «не покрывает», а не «не затронутой»', () => {
    const call = parseAxisAnswer('Настройки', 'да | claim-1 про другую переменную | src/tariffs.ts:11', 'src/tariffs.ts', true);
    ok(call !== null && call.kind === 'record_finding');
    ok(call.text.includes('объявлена затронутой'), call.text);
    ok(call.text.includes('не покрывает'), call.text);
    ok(!call.text.includes('не затронутой'), call.text);
  });

  it('«нет» — ось не тронута (или, для затронутой, заявленный исход покрывает всё)', () => {
    strictEqual(parseAxisAnswer('Наблюдаемость', 'нет', 'a.ts', false), null);
    strictEqual(parseAxisAnswer('Наблюдаемость', 'нет', 'a.ts', true), null);
  });

  it('свободная форма «Да, …» без «|» не теряется — \\b по кириллице не работает', () => {
    // `/^да\b/i.test('да')` — `false`: граница слова считается по ASCII (CLAUDE.md).
    // Раньше эта строка отбрасывалась как неразобранная — терялась ровно та свободная
    // форма ответа, ради которой и был написан фолбэк `head.replace(/^(да|yes).../)`.
    const call = parseAxisAnswer('Настройки', 'Да, читается TARIFF_ZONE_EXTRA', 'src/tariffs.ts', false);
    ok(call !== null && call.kind === 'record_finding', String(call));
    ok(call.text.includes('TARIFF_ZONE_EXTRA'), call.text);
    strictEqual(call.evidence, 'src/tariffs.ts');
  });

  it('«давно»/«дальше» не считаются утвердительным ответом (граница окончания, а не префикс)', () => {
    strictEqual(parseAxisAnswer('Настройки', 'давно известно, что тут ничего нет', 'a.ts', false), null);
  });
});

describe('нарезка под потолок', () => {
  it('хунк меньше потолка идёт целиком, больше — режется по границам @@', () => {
    const hunks = splitHunks(DIFF);
    strictEqual(sliceHunks(hunks, 100_000).length, 2);
    const big = { file: 'x.ts', text: ['diff --git a/x.ts b/x.ts', '@@ -1 +1 @@', '+'.repeat(80), '@@ -9 +9 @@', '-'.repeat(80)].join('\n') };
    const parts = sliceHunks([big], 140);
    ok(parts.length >= 2, String(parts.length));
    ok(parts.every((p) => p.file === 'x.ts'));
  });

  it('КАЖДЫЙ фрагмент — под потолком в БАЙТАХ, не в code unit\'ах JS-строки', () => {
    // Кириллица — 2 байта на символ в UTF-8: `.slice(0, budgetBytes)` резала бы почти
    // вдвое длиннее потолка. Первый `@@`-блок уже сам по себе больше потолка — раньше
    // такой фрагмент уходил целиком, без обрезки вовсе (клэмп стоял только на хвосте).
    const budget = 100;
    const cyrillic = 'кириллица '.repeat(20); // ~200 байт UTF-8 на один @@-блок
    const big = {
      file: 'src/tariffs.ts',
      text: [
        'diff --git a/src/tariffs.ts b/src/tariffs.ts',
        `@@ -1 +1 @@ ${cyrillic}`,
        `@@ -9 +9 @@ ${cyrillic}`,
        `@@ -20 +20 @@ ${cyrillic}`,
      ].join('\n'),
    };
    const parts = sliceHunks([big], budget);
    ok(parts.length >= 3, String(parts.length));
    for (const p of parts) {
      ok(Buffer.byteLength(p.text, 'utf8') <= budget, `${p.text.length} символов, ${Buffer.byteLength(p.text, 'utf8')} байт`);
    }
  });
});

describe('конвейер', () => {
  it('по вопросу на фрагмент и на КАЖДУЮ ось (трек 1а — не только «не затронутые»); находки — записи', async () => {
    const provider = scripted([
      'review | чтение TARIFF_ZONE_EXTRA без умолчания | src/tariffs.ts:11',
      'review | тест сравнивает q.total с самим собой | test/oversize.test.ts:1',
      'да | читается переменная окружения | src/tariffs.ts:11',
      'нет',
      'да | claim-1 говорит про другое | src/tariffs.ts:11',
    ]);
    const r = await reviewByHunks({
      provider,
      model: 'stub',
      params: null,
      taskContext: '| claim-1 | надбавка 40% | тест |',
      diff: DIFF,
      axes: [
        { name: 'Настройки', affected: false, outcomeRaw: 'н/п — не трогаем' },
        { name: 'Наблюдаемость', affected: false, outcomeRaw: 'н/п' },
        { name: 'Безопасность', affected: true, outcomeRaw: 'claim-1' },
      ],
      hunkBudgetBytes: 12_000,
      signal: new AbortController().signal,
    });
    strictEqual(r.hunksAsked, 2);
    strictEqual(r.hunksAnswered, 2);
    strictEqual(r.axesAsked, 3);
    strictEqual(r.findings.length, 4);
    ok(r.findings.every((f) => f.kind === 'record_finding'));
    // Затронутая ось теперь ТОЖЕ спрашивается — вопрос про то, покрывает ли заявленный
    // исход реально сделанное, а не «трогает ли» (план и так сказал «да»).
    ok(provider.asked.some((q) => q.includes('«Безопасность» — в плане объявлена ЗАТРОНУТОЙ')));
    // Сводка называет проверенные файлы — этим она и якорится к патчу.
    ok(r.text.includes('src/tariffs.ts') && r.text.includes('test/oversize.test.ts'));
    ok(r.text.includes('фрагментов проверено 2 из 2'));
  });

  it('чистый diff: все «нет» — находок нет, конвейер полный', async () => {
    const r = await reviewByHunks({
      provider: scripted(['нет', 'нет']),
      model: 'stub',
      params: null,
      taskContext: '',
      diff: DIFF,
      axes: [],
      hunkBudgetBytes: 12_000,
      signal: new AbortController().signal,
    });
    deepStrictEqual(r.findings, []);
    strictEqual(r.hunksAnswered, r.hunksAsked);
    ok(r.text.includes('Находок нет'));
  });

  it('упавший запрос — «не отвечено», а не молчаливый пропуск', async () => {
    let n = 0;
    const provider = {
      name: 'stub',
      async chat() {
        n++;
        if (n === 1) throw new Error('ollama: ответ не получен');
        return {
          text: 'нет',
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, durationMs: 1, envBlocked: false },
          finishReason: 'end_turn' as const,
        };
      },
    } as unknown as ChatProvider;
    const notes: string[] = [];
    const r = await reviewByHunks({
      provider,
      model: 'stub',
      params: null,
      taskContext: '',
      diff: DIFF,
      axes: [],
      hunkBudgetBytes: 12_000,
      signal: new AbortController().signal,
      onProgress: (m) => notes.push(m),
    });
    strictEqual(r.hunksAsked, 2);
    strictEqual(r.hunksAnswered, 1);
    ok(notes.some((m) => m.includes('не отвечен')));
  });

  it('отмена останавливает конвейер между ПАЧКАМИ, не откатывая уже пришедшие в пачке ответы', async () => {
    // Три хунка, REVIEW_PARALLEL = 3 — все в одной пачке: abort() внутри первого же
    // вызова не успевает предотвратить два соседних в ТОЙ ЖЕ пачке (они уже запущены), но
    // обязан остановить пачку осей, идущую следующей.
    const threeFileDiff = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1 +1 @@',
      '+x',
      'diff --git a/b.ts b/b.ts',
      '--- a/b.ts',
      '+++ b/b.ts',
      '@@ -1 +1 @@',
      '+y',
      'diff --git a/c.ts b/c.ts',
      '--- a/c.ts',
      '+++ b/c.ts',
      '@@ -1 +1 @@',
      '+z',
    ].join('\n');
    const ctl = new AbortController();
    const provider = {
      name: 'stub',
      async chat() {
        ctl.abort();
        return {
          text: 'нет',
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, durationMs: 1, envBlocked: false },
          finishReason: 'end_turn' as const,
        };
      },
    } as unknown as ChatProvider;
    const r = await reviewByHunks({
      provider,
      model: 'stub',
      params: null,
      taskContext: '',
      diff: threeFileDiff,
      axes: [{ name: 'Настройки', affected: false, outcomeRaw: '' }],
      hunkBudgetBytes: 12_000,
      signal: ctl.signal,
    });
    strictEqual(r.hunksAsked, 3);
    strictEqual(r.hunksAnswered, 3);
    strictEqual(r.axesAnswered, 0);
  });

  it('пачка размера REVIEW_PARALLEL: упавший запрос не топит соседей по пачке', async () => {
    // Четыре хунка — первая пачка (3) содержит один падающий запрос, вторая пачка (1)
    // приходит целиком: Promise.allSettled не теряет фрагменты, ответившие рядом с упавшим.
    const fourFileDiff = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ a/a.ts',
      '@@ -1 +1 @@',
      '+1',
      'diff --git a/b.ts b/b.ts',
      '--- a/b.ts',
      '+++ b/b.ts',
      '@@ -1 +1 @@',
      '+2',
      'diff --git a/c.ts b/c.ts',
      '--- a/c.ts',
      '+++ b/c.ts',
      '@@ -1 +1 @@',
      '+3',
      'diff --git a/d.ts b/d.ts',
      '--- a/d.ts',
      '+++ b/d.ts',
      '@@ -1 +1 @@',
      '+4',
    ].join('\n');
    let n = 0;
    const provider = {
      name: 'stub',
      async chat() {
        n++;
        if (n === 2) throw new Error('ollama: ответ не получен');
        return {
          text: 'нет',
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, durationMs: 1, envBlocked: false },
          finishReason: 'end_turn' as const,
        };
      },
    } as unknown as ChatProvider;
    const notes: string[] = [];
    const r = await reviewByHunks({
      provider,
      model: 'stub',
      params: null,
      taskContext: '',
      diff: fourFileDiff,
      axes: [],
      hunkBudgetBytes: 12_000,
      signal: new AbortController().signal,
      onProgress: (m) => notes.push(m),
    });
    strictEqual(r.hunksAsked, 4);
    strictEqual(r.hunksAnswered, 3);
    ok(notes.some((m) => m.includes('не отвечен')));
  });
});
