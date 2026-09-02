/**
 * Обрезка истории хода (`exec/history.ts`).
 *
 * Сторожится: под бюджетом история не меняется; над бюджетом заглушки ставятся от самого
 * старого результата к новым; результаты текущего хода, последние результаты и ответы
 * человека не трогаются; промпт и ходы модели не трогаются; исходный массив не мутируется.
 */

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { HISTORY_KEEP_LAST, stubbedCount, trimHistory } from '../src/exec/history.ts';
import type { ChatMessage } from '../src/provider/ChatProvider.ts';

function tool(name: string, size: number, id = name): ChatMessage {
  return { role: 'tool', toolCallId: id, name, content: `${name}: первая строка\n${'x'.repeat(size)}` };
}

function turn(text: string): ChatMessage {
  return { role: 'assistant', content: text, toolCalls: [] };
}

const HEAD: ChatMessage[] = [
  { role: 'system', content: 'системный промпт этапа' },
  { role: 'user', content: 'входные артефакты' },
];

describe('обрезка истории хода', () => {
  it('под бюджетом ничего не меняет', () => {
    const msgs = [...HEAD, turn('a'), tool('Read', 100), turn('b'), tool('Edit', 100)];
    deepStrictEqual(trimHistory(msgs, 10_000), msgs);
  });

  it('над бюджетом режет самый старый результат первым, последние держит целиком', () => {
    const msgs = [...HEAD];
    for (let i = 0; i < 6; i++) {
      msgs.push(turn(`ход ${i}`));
      msgs.push(tool(`Read${i}`, 2_000, `id${i}`));
    }
    const out = trimHistory(msgs, 8_000);
    ok(out[3]!.role === 'tool' && out[3]!.content.includes('история сокращена'), out[3]!.content);
    let kept = 0;
    for (let i = out.length - 1; i >= 0 && kept < HISTORY_KEEP_LAST; i--) {
      const m = out[i]!;
      if (m.role !== 'tool') continue;
      ok(!m.content.includes('история сокращена'));
      kept++;
    }
    ok(stubbedCount(out) >= 1);
    // Заглушка сохраняет первую строку и имя инструмента.
    ok(out[3]!.content.startsWith('Read0: первая строка'));
    ok(out[3]!.content.includes('«Read0»'));
  });

  it('промпт и ходы модели не трогает и исходный массив не мутирует', () => {
    const msgs: ChatMessage[] = [
      ...HEAD,
      turn('думаю'),
      tool('A', 5_000, 'a'),
      turn('ещё'),
      tool('B', 5_000, 'b'),
      turn('ещё'),
      tool('C', 5_000, 'c'),
      turn('ещё'),
      tool('D', 5_000, 'd'),
    ];
    const before = JSON.stringify(msgs);
    const out = trimHistory(msgs, 12_000, 2);
    strictEqual(JSON.stringify(msgs), before);
    strictEqual(out[0], msgs[0]);
    strictEqual(out[2], msgs[2]);
    ok(out[3]!.content.includes('история сокращена'));
    ok(!out[9]!.content.includes('история сокращена'));
  });

  it('результаты текущего хода (после последнего ответа модели) не трогаются', () => {
    const msgs: ChatMessage[] = [
      ...HEAD,
      turn('ход 1'),
      tool('Old', 5_000, 'o'),
      turn('ход 2'),
      tool('R1', 10_000, 'r1'),
      tool('R2', 10_000, 'r2'),
      tool('R3', 10_000, 'r3'),
      tool('R4', 10_000, 'r4'),
      tool('R5', 10_000, 'r5'),
    ];
    const out = trimHistory(msgs, 40_000, 1);
    // Пять результатов одного хода модель ещё не видела — ни один не стаблен, даже сверх бюджета.
    for (let i = 5; i <= 9; i++) ok(!out[i]!.content.includes('история сокращена'), `индекс ${i}`);
    ok(out[3]!.content.includes('история сокращена'));
  });

  it('ответ человека (AskHuman) не стабится никогда', () => {
    const msgs: ChatMessage[] = [
      ...HEAD,
      turn('спрошу'),
      tool('AskHuman', 5_000, 'h'),
      turn('читаю'),
      tool('Read', 5_000, 'a'),
      turn('ещё'),
      tool('Read', 5_000, 'b'),
      turn('ещё'),
      tool('Read', 5_000, 'c'),
    ];
    const out = trimHistory(msgs, 6_000, 1);
    ok(!out[3]!.content.includes('история сокращена'));
    ok(out[5]!.content.includes('история сокращена'));
  });

  it('уже сокращённый результат второй раз не трогается', () => {
    const msgs: ChatMessage[] = [...HEAD];
    for (const [name, id] of [['A', 'a'], ['B', 'b'], ['C', 'c'], ['D', 'd']] as const) {
      msgs.push(turn(`зову ${name}`));
      msgs.push(tool(name, 5_000, id));
    }
    const once = trimHistory(msgs, 6_000, 1);
    const twice = trimHistory(once, 6_000, 1);
    strictEqual(stubbedCount(twice), stubbedCount(once));
    deepStrictEqual(twice, once);
  });
});
