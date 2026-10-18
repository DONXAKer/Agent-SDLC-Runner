/**
 * Этап 3 закрывается артефактом всегда (`SDLC.md`): нет вопросов — отчёт «по существу
 * пусто» с подписью оператора, отличимый и от бланка, и от пропущенного этапа.
 */

import { ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { countPlaceholders } from '../src/artifacts/artifact.ts';
import { emptyClarificationReport } from '../src/run/stages/ask.ts';

const FORM = [
  '<!-- sdlc-template: clarification-report v1 -->',
  '# Вопросы и ответы: demo',
  '',
  '- **Задача:** `intent.md` (demo) — ‹одно предложение о цели›',
  '- **Разведка:** `exploration-report.md`',
  '',
  '## Вопросы и ответы',
  '',
  '| # | Вопрос | Блокирующий | Ответ человека | Что изменилось в задаче |',
  '|---|---|---|---|---|',
  '| 1 | ‹вопрос› | ‹да/нет› | ‹ответ› / (пропущено) | ‹что поправлено или добавлено› / ничего |',
  '',
  '## Уточнённое требование и подход',
  '',
  '‹уточнённое требование и подход›',
  '',
  '## Отложено',
  '',
  '- ‹вопрос› — ‹почему допустимо начинать без ответа›',
  '- нет отложенных',
  '',
].join('\n');

describe('отчёт по вопросам «по существу пусто»', () => {
  it('закрывает все места формы записью с подписью', () => {
    const note = 'по существу пусто — открытых вопросов нет, Иван · 2026-09-24';
    const text = emptyClarificationReport(FORM, note);
    strictEqual(countPlaceholders(text), 0, text);
    ok(text.includes(`| — | ${note} | н/п | н/п | ничего |`), text);
    ok(text.includes('- нет отложенных') && !text.includes('‹вопрос›'));
  });
});
