import { ok, strictEqual } from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import {
  DECISION,
  countPlaceholders,
  decisionValue,
  placeholderRanges,
  readDecision,
  setDecision,
  writeArtifact,
} from '../src/artifacts/artifact.ts';
import { WitokPaths } from '../src/artifacts/paths.ts';
import { checkPreconditions, stageById } from '../src/run/stages.ts';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'sdlc-test-')));
after(() => rmSync(root, { recursive: true, force: true }));

const paths = new WitokPaths(root, 'demo');
const ctx = { paths, chunk: 1, attempt: 1 };

// Строки взяты дословно из форм методологии — сверка держится на них.
const PLAN_UNAPPROVED =
  '# План\n\n- **База:** ‹base_sha — коммит, от которого пойдёт diff›\n' +
  '- **Одобрение:** ‹имя› · ‹дата› / **не одобрен — этап 5 не начинается**\n';

describe('плейсхолдеры', () => {
  it('считает незаполненные места', () => {
    strictEqual(countPlaceholders(PLAN_UNAPPROVED), 3);
    strictEqual(countPlaceholders('всё заполнено'), 0);
  });

  it('отдаёт позиции для подсветки', () => {
    const r = placeholderRanges('a ‹раз› b ‹два›');
    strictEqual(r.length, 2);
    strictEqual(r[0]!.text, '‹раз›');
    strictEqual(r[1]!.start, 10);
  });

  it('повторный вызов не зависит от предыдущего — regex не stateful', () => {
    const t = 'a ‹x› b ‹y›';
    strictEqual(countPlaceholders(t), 2);
    strictEqual(countPlaceholders(t), 2);
    strictEqual(placeholderRanges(t).length, 2);
    strictEqual(placeholderRanges(t).length, 2);
  });
});

describe('поля решений человека', () => {
  it('незаполненное поле — не одобрение', () => {
    const d = readDecision(PLAN_UNAPPROVED, DECISION.approval);
    strictEqual(d.state, 'placeholder');
  });

  it('отсутствие поля отличается от незаполненного', () => {
    strictEqual(readDecision('# План\nбез поля', DECISION.approval).state, 'missing');
  });

  it('отрицательное решение не считается одобрением', () => {
    const t = '- **Одобрение:** **не одобрен — этап 5 не начинается**';
    strictEqual(readDecision(t, DECISION.approval).state, 'declined');
  });

  it('«не принималась — обрыв» в приёмке тоже отрицательное', () => {
    const t = '- **Приёмка:** **не принималась — обрыв: кончился бюджет**';
    strictEqual(readDecision(t, DECISION.accepted).state, 'declined');
  });

  // Регрессия: DOUBLE_NEGATIVE_SAFE_WORD не включал корни самого NEGATIVE_TRIGGER
  // (отклон/отказ/отверг/провал) — «не провален»/«не отклонён» читались как отказ,
  // хотя это двойное отрицание с положительным итогом, как и «не пропущен».
  it('двойное отрицание с корнем самого триггера — не отказ', () => {
    for (const v of ['не отклонён', 'не отказано', 'не отвергнут', 'не провален']) {
      const t = `- **Одобрение:** **${v}** — Иван · 2026-08-16`;
      const d = readDecision(t, DECISION.approval);
      strictEqual(d.state, 'granted', `«${v}» — двойное отрицание, не должно быть отказом`);
    }
  });

  it('заполненное поле читается как одобрение', () => {
    const t = setDecision(PLAN_UNAPPROVED, DECISION.approval, decisionValue('Иван', new Date('2026-08-16')));
    const d = readDecision(t, DECISION.approval);
    strictEqual(d.state, 'granted');
    strictEqual(d.raw, 'Иван · 2026-08-16');
  });

  it('запись решения не трогает другие строки', () => {
    const t = setDecision(PLAN_UNAPPROVED, DECISION.approval, 'Иван · 2026-08-16');
    ok(t.includes('- **База:** ‹base_sha'), t);
    strictEqual(countPlaceholders(t), 1);
  });

  it('поле без жирной разметки метки тоже находится', () => {
    const t = '**Решение человека о полноте:** лист полон — Иван · 2026-08-16';
    strictEqual(readDecision(t, DECISION.checklistComplete).state, 'granted');
  });

  // Регрессия: раньше сходило любое непустое значение, и «см. выше» открывало следующий
  // этап. Решение без подписи и даты для методологии не существует — читаем fail-closed.
  it('значение без подписи или без даты одобрением не считается', () => {
    for (const v of ['лист полон', 'ок', 'Иван', '2026-08-16', 'см. переписку']) {
      const d = readDecision(`- **Одобрение:** ${v}`, DECISION.approval);
      strictEqual(d.state, 'placeholder', `«${v}» не должно быть одобрением`);
      ok(d.state === 'placeholder' && d.why !== '', 'причина обязана быть названа');
    }
  });

  it('зачёркнутое прежнее решение не воскресает', () => {
    const t = `- **Одобрение:** ~~Иван · 2026-08-01~~ отозвано, план переписан`;
    strictEqual(readDecision(t, DECISION.approval).state, 'placeholder');
  });
});

describe('предусловия этапов', () => {
  it('chunk не начинается без заполненного поля одобрения', () => {
    writeArtifact(paths.plan, PLAN_UNAPPROVED);
    const r = checkPreconditions(stageById('chunk'), ctx);
    ok(!r.ok);
    ok(r.problems.some((p) => /Молчание одобрением не считается/.test(p)), r.problems.join('; '));
  });

  it('chunk начинается, когда одобрение записано в файл', () => {
    writeArtifact(paths.plan, setDecision(PLAN_UNAPPROVED, DECISION.approval, 'Иван · 2026-08-16'));
    const r = checkPreconditions(stageById('chunk'), ctx);
    ok(r.ok, r.problems.join('; '));
  });

  it('отрицательное решение блокирует так же, как незаполненное', () => {
    writeArtifact(
      paths.plan,
      '- **Одобрение:** **не одобрен — этап 5 не начинается**\n',
    );
    const r = checkPreconditions(stageById('chunk'), ctx);
    ok(!r.ok);
  });

  it('разведка требует задачи без плейсхолдеров', () => {
    writeArtifact(paths.intent, '# Задача\n- Коротко: ‹что делаем›\n');
    writeArtifact(paths.readiness, '# Готовность\nвердикт: готова\n');
    const r = checkPreconditions(stageById('explore'), ctx);
    ok(!r.ok);
    ok(r.problems.some((p) => /осталось незаполненных мест: 1/.test(p)), r.problems.join('; '));
  });

  it('условный этап «вопросы» пропускается, когда развилок нет', () => {
    writeArtifact(paths.intent, '# Задача\nвсё ясно\n');
    writeArtifact(paths.explorationReport, '# Разведка\nвопросов не осталось\n');
    const r = checkPreconditions(stageById('ask'), ctx);
    ok(r.ok);
    ok(r.skip !== null, 'этап должен быть помечен к пропуску');
  });

  it('условный этап «вопросы» не пропускается при открытом вопросе', () => {
    writeArtifact(paths.intent, '# Задача\n- [ ] **[блокирующий]** какой формат даты?\n');
    const r = checkPreconditions(stageById('ask'), ctx);
    ok(r.ok);
    strictEqual(r.skip, null);
  });

  // Регрессия: передача была без предусловий совсем, и этап 7, дёрнутый из любого
  // состояния, оформлял коммит как принятую работу — вердикта при этом могло не быть вовсе.
  it('передача не идёт без зелёного отчёта приёмки', () => {
    const r = checkPreconditions(stageById('handoff'), ctx);
    ok(!r.ok);
    ok(r.problems.some((p) => /обрыв/.test(p)), r.problems.join('; '));
  });

  it('обрыв витка передачу открывает — но только объявленный явно', () => {
    const r = checkPreconditions(stageById('handoff'), ctx, { abortHandoff: true });
    ok(r.ok, r.problems.join('; '));
  });
});

describe('раскладка артефактов', () => {
  it('попытки не перезаписываются — у каждой свой файл', () => {
    ok(paths.chunkDiff(1, 1) !== paths.chunkDiff(1, 2));
    ok(paths.verificationReport(1, 1) !== paths.verificationReport(1, 2));
  });

  it('набор гейтов — файл проекта, а не витка', () => {
    ok(paths.gates.endsWith(join('.sdlc', 'gates.md')));
    ok(!paths.gates.includes(join('.sdlc', 'demo')));
  });
});
