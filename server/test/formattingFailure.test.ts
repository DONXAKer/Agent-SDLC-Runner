/**
 * Что считается падением на ОФОРМЛЕНИИ (`isFormattingFailure`) — то есть какой провал
 * этапа рантайм вправе закрыть дозаполнением бланка по полям.
 *
 * Дефект, ради которого список расширен, пойман замером 2026-09-08: шесть прогонов
 * `gpt-oss-20b` рецензентом этапа 6, во всех отчёт приёмки остался шаблоном — 141 строка,
 * 20 плейсхолдеров, НОЛЬ упоминаний посеянного дефекта. Причина «модель упёрлась в лимит
 * длины ответа» в список не входила, спасательный путь не запускался, и замер мерил не
 * зоркость модели, а её способность напечатать длинный бланк одним сообщением.
 *
 * Обратная половина списка важнее прямой: провал по политике, деньгам или отмене закрывать
 * дозаполнением НЕЛЬЗЯ — там красное обязано остаться красным.
 */

import { strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isFormattingFailure, recheckGuardAfterTopUp } from '../src/run/Run.ts';

describe('падение на оформлении закрывается дозаполнением', () => {
  it('исчерпан лимит ходов — закрывается', () => {
    strictEqual(isFormattingFailure('исчерпан лимит ходов этапа (25)'), true);
  });

  it('артефакт остался с плейсхолдерами — закрывается', () => {
    strictEqual(isFormattingFailure('артефакт этапа не заполнен: мест 20'), true);
  });

  it('лимит длины ответа — закрывается (замер 2026-09-08)', () => {
    strictEqual(isFormattingFailure('модель упёрлась в лимит длины ответа'), true);
  });

  it('обрыв посреди вызова инструмента — тот же класс, закрывается', () => {
    // Самый частый исход слабой модели С tool-use: длинный Write бланка не влез в ответ.
    strictEqual(
      isFormattingFailure('ход обрезан лимитом длины на середине вызова инструмента — не исполняем'),
      true,
    );
  });

  it('антицикл FinalizeArtifact — закрывается (замер серии v4, 2026-09-14)', () => {
    // Рескью per-field дозаполнением уже запускался безусловно (finishFormArtifact), но
    // успех не засчитывался: паттерн антицикла не входил в этот список.
    strictEqual(
      isFormattingFailure(
        'этап зациклился на правке «exploration-report.md» без прогресса: число ' +
          'незаполненных мест не убывает 3 отказов подряд (28 → 28 → 28) — застряло: X',
      ),
      true,
    );
  });
});

describe('провал по существу дозаполнением НЕ закрывается', () => {
  it('отказ политики', () => {
    strictEqual(isFormattingFailure('вызов отклонён политикой: planScope'), false);
  });

  it('исчерпан бюджет денег', () => {
    strictEqual(isFormattingFailure('бюджет прогона исчерпан: $8.1476 из $5.0000'), false);
  });

  it('отмена оператором', () => {
    strictEqual(isFormattingFailure('этап отменён оператором'), false);
  });

  it('транспортный таймаут — это среда, а не оформление', () => {
    strictEqual(isFormattingFailure('ollama: ответ не получен за 1200000 мс — таймаут запроса'), false);
  });

  it('ход оборван без вызовов — причина не названа, закрывать нечего', () => {
    strictEqual(
      isFormattingFailure('ход оборван: причина завершения «other», вызовов инструментов нет'),
      false,
    );
  });

  it('пустая заметка', () => {
    strictEqual(isFormattingFailure(''), false);
  });

  // «Этап зациклился» рождается только застреванием FinalizeArtifact — на chunk это журнал,
  // то есть оформление; недописанный код сторожит место переворота, а не классификация.
  it('антицикл застрявшего журнала — оформление', () => {
    strictEqual(isFormattingFailure('этап зациклился на правке «.sdlc/s/chunk-1-journal.md» без прогресса'), true);
    strictEqual(isFormattingFailure('исчерпан лимит ходов этапа (40)'), true);
  });
});

describe('recheckGuardAfterTopUp — пересчёт стража после доборов (code-review-all 2026-09-23)', () => {
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, durationMs: 0 };
  const failed = (note: string) => ({ ok: false, finalText: '', usage, note });

  it('провал на находке стража, добор её закрыл — ok с closedBy runtime', () => {
    const r = recheckGuardAfterTopUp(failed('нет строк для осей'), 'нет строк для осей', () => null);
    strictEqual(r.ok, true);
    strictEqual(r.closedBy, 'runtime');
  });

  it('находка осталась — провал со свежим текстом стража', () => {
    const r = recheckGuardAfterTopUp(failed('старая находка'), 'старая находка', () => 'новая находка');
    strictEqual(r.ok, false);
    strictEqual(r.note, 'новая находка');
  });

  it('провал НЕ на страже (бюджет) при молчащем страже — остаётся провалом со своей причиной', () => {
    const note = 'бюджет прогона исчерпан: $1.10 из $1';
    const r = recheckGuardAfterTopUp(failed(note), 'давняя находка', () => null);
    strictEqual(r.ok, false);
    strictEqual(r.note, note);
    const never = recheckGuardAfterTopUp(failed('исчерпан лимит ходов этапа (40)'), null, () => null);
    strictEqual(never.ok, false, 'без полного артефакта лимит ходов не спасается');
  });

  it('лимит ходов при полном артефакте и молчащем страже — спасён с исходной причиной в заметке', () => {
    const note = 'исчерпан лимит ходов этапа (40)';
    const r = recheckGuardAfterTopUp(failed(note), null, () => null, () => true);
    strictEqual(r.ok, true);
    strictEqual(r.closedBy, 'runtime');
    strictEqual(r.note.startsWith(note), true, r.note);
  });

  it('лимит ходов, страж не молчит — исходная причина сохраняется', () => {
    const note = 'исчерпан лимит ходов этапа (40)';
    const r = recheckGuardAfterTopUp(failed(note), null, () => 'нет строк для осей', () => true);
    strictEqual(r.ok, false);
    strictEqual(r.note, note);
  });

  it('бюджет не спасается даже при полном артефакте', () => {
    const note = 'бюджет прогона исчерпан: $1.10 из $1';
    const r = recheckGuardAfterTopUp(failed(note), null, () => null, () => true);
    strictEqual(r.ok, false);
  });
});
