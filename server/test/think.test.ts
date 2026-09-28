import { strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { stripLeadingThink } from '../src/provider/think.ts';

describe('stripLeadingThink', () => {
  it('без think — текст не меняется', () => {
    strictEqual(stripLeadingThink('обычный ответ'), 'обычный ответ');
  });

  it('снимает один ведущий закрытый блок', () => {
    strictEqual(stripLeadingThink('<think>рассуждение</think>\nответ'), 'ответ');
  });

  it('снимает несколько ведущих блоков подряд', () => {
    strictEqual(stripLeadingThink('<think>a</think>\n<think>b</think>\nответ'), 'ответ');
  });

  it('ведущие пробелы/переносы перед тегом — тоже снимается', () => {
    strictEqual(stripLeadingThink('  \n<think>a</think>\n\nответ'), 'ответ');
  });

  it('незакрытый ведущий think — генерация оборвана, текст оставлен как есть (не схлопывается в «»)', () => {
    // Раньше схлопывался в '' — это завело регрессию: isNoAnswer('') читает пустую строку
    // как явное «нет», и оборванная генерация проходила как «дефектов нет» (code-review-all,
    // 2026-09-28). Оставленная прозой генерация и без того не пройдёт isNoAnswer (не «нет»)
    // и не пройдёт extractReviewJson (не JSON) — тем же путём, что и любой другой мусорный
    // ответ, без отдельного ложного «нет».
    const raw = '<think>рассуждение без конца, лимит длины';
    strictEqual(stripLeadingThink(raw), raw);
  });

  it('think в СЕРЕДИНЕ содержательного текста не трогается', () => {
    const text = 'начало\n<think>вставка</think>\nконец';
    strictEqual(stripLeadingThink(text), text);
  });

  it('пустой текст остаётся пустым', () => {
    strictEqual(stripLeadingThink(''), '');
  });

  it('после снятия think остаётся пусто — это НЕ незакрытый think, но и не ответ', () => {
    strictEqual(stripLeadingThink('<think>рассуждение</think>'), '');
  });
});
