import { ok, strictEqual } from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import {
  DECISION,
  branchNameFromField,
  countPlaceholders,
  countPlaceholdersExceptSections,
  decisionValue,
  placeholderRanges,
  readDecision,
  readField,
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

  // Регрессия: NEGATIVE_TRIGGER ловил «не + любое слово», поэтому посторонняя реплика
  // внутри поля («класс не переименовываем» — пояснение к сфере правки, не вердикт)
  // читалась как отказ, хотя всё поле в целом — согласие человека.
  it('«не» вне глагола решения не читается как отказ', () => {
    const t =
      '- **Подтвердил:** Иван · 2026-08-16 (через `mcp__sdlc__ask_human`: «Подтверждаю ' +
      'как в плане» — точки правки как в плане, javadoc-ссылку правим, класс не переименовываем)';
    strictEqual(readDecision(t, DECISION.confirmed).state, 'granted');
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

describe('readField: сырое значение простого поля', () => {
  it('заполненное поле возвращается как есть', () => {
    strictEqual(readField('- **Ветка витка:** sdlc/auth-104', 'Ветка витка'), 'sdlc/auth-104');
  });

  it('плейсхолдер, пусто и отсутствие поля — всё null', () => {
    strictEqual(readField('- **Ветка витка:** ‹sdlc/слаг или по конвенции проекта›', 'Ветка витка'), null);
    strictEqual(readField('- **Ветка витка:** ', 'Ветка витка'), null);
    strictEqual(readField('# План\nбез поля', 'Ветка витка'), null);
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

  // Регрессия: шаблон интента сам объявляет секцию «Что придётся тронуть» законно пустой
  // на первом проходе («заполняет разведка на этапе 2»), но предусловие разведки считало
  // и её — разведка не запускалась НИ РАЗУ на живом первом проходе (поймано контрольным
  // прогоном бенчмарка).
  it('разведка запускается, когда пуста только секция «Что придётся тронуть»', () => {
    writeArtifact(
      paths.intent,
      '# Задача\n- Коротко: делаем штуку\n\n| claim-1 | пункт | тест |\n| claim-2 | [edge] пункт | тест |\n| claim-3 | [edge] пункт | тест |\n\n## Что придётся тронуть\n- ‹path/to/file› — ‹что здесь меняем›\n',
    );
    writeArtifact(paths.readiness, '# Готовность\nвердикт: готова\n');
    const r = checkPreconditions(stageById('explore'), ctx);
    ok(r.ok, r.problems.join('; '));
  });

  it('план по-прежнему требует секцию «Что придётся тронуть» заполненной', () => {
    writeArtifact(
      paths.intent,
      '# Задача\n- Коротко: делаем штуку\n\n## Что придётся тронуть\n- ‹path/to/file› — ‹что здесь меняем›\n',
    );
    writeArtifact(paths.explorationReport, '# Разведка\nготово\n');
    const r = checkPreconditions(stageById('plan'), ctx);
    ok(!r.ok);
    ok(r.problems.some((p) => /осталось незаполненных мест/.test(p)), r.problems.join('; '));
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

  // Живой прогон ta-13: интент-модель сжала входную задачу с четырьмя клеймами до одного
  // и сама отчиталась «готова» — минимум листа теперь конструкция, а не самопроверка.
  it('разведка не идёт с листом короче минимума (полный контур: <3 пунктов)', () => {
    writeArtifact(paths.intent, [
      '# Задача',
      '- **Контур:** полный',
      '| id | Пункт | Как проверить |',
      '| claim-1 | один пункт | тест |',
    ].join('\n'));
    writeArtifact(paths.readiness, '# Готовность\nготова\n');
    const r = checkPreconditions(stageById('explore'), ctx);
    ok(!r.ok);
    ok(r.problems.some((p) => /короче минимума/.test(p)), r.problems.join('; '));
  });

  it('разведка идёт с полным листом (3 пункта, 2 edge)', () => {
    writeArtifact(paths.intent, [
      '# Задача',
      '- **Контур:** полный',
      '| id | Пункт | Как проверить |',
      '| claim-1 | пункт | тест |',
      '| claim-2 | [edge] пункт | тест |',
      '| claim-3 | [edge] пункт | тест |',
    ].join('\n'));
    writeArtifact(paths.readiness, '# Готовность\nготова\n');
    const r = checkPreconditions(stageById('explore'), ctx);
    ok(!r.problems.some((p) => /короче минимума/.test(p)), r.problems.join('; '));
  });

  // Живой прогон ta-13: разведчик сочинил карту с несуществующими путями и финализировал —
  // «заполненность» его пропустила. Существование путей карты — детектор сочинённого отчёта.
  it('вопросы/план не идут по карте с несуществующими путями', () => {
    writeArtifact(paths.intent, [
      '# Задача', '- **Контур:** полный',
      '| claim-1 | пункт | тест |', '| claim-2 | [edge] пункт | тест |', '| claim-3 | [edge] пункт | тест |',
    ].join('\n'));
    writeArtifact(paths.explorationReport, [
      '# Отчёт разведки', '## Карта кодовой базы',
      '| Путь от корня | Что там сейчас | Что меняем |', '|---|---|---|',
      '| frontend/components/undo-toast.jsx | пусто | реализовать |',
    ].join('\n'));
    const r = checkPreconditions(stageById('ask'), ctx);
    ok(r.problems.some((p) => /несуществующие пути/.test(p)), r.problems.join('; '));
  });

  // Живой прогон ta-13 (второй): честный отчёт с шапкой «| Файл |» ложно падал —
  // детектор шапки знал только слово «путь». Не-путь (без / и точки) — не проверяем.
  it('шапка «Файл» и адрес `путь:метод` не дают ложного срабатывания', () => {
    writeArtifact(paths.explorationReport, [
      '# Отчёт разведки', '## Карта кодовой базы',
      '| Файл | Что там сейчас | Что меняем |', '|---|---|---|',
      '| `backend/app/task_service.py:apply_task_update` | спавн повтора | расширить |',
    ].join('\n'));
    writeArtifact(join(root, 'backend/app/task_service.py'), 'x = 1');
    const r = checkPreconditions(stageById('ask'), ctx);
    ok(!r.problems.some((p) => /несуществующие пути/.test(p)), r.problems.join('; '));
  });

  it('строка карты с пометкой «новый» не считается несуществующим путём', () => {
    writeArtifact(paths.explorationReport, [
      '# Отчёт разведки', '## Карта кодовой базы',
      '| Путь от корня | Что там сейчас | Что меняем |', '|---|---|---|',
      '| frontend/src/NewToast.tsx | новый файл | создать |',
    ].join('\n'));
    const r = checkPreconditions(stageById('ask'), ctx);
    ok(!r.problems.some((p) => /несуществующие пути/.test(p)), r.problems.join('; '));
  });

  // Живой прогон r32: модель написала ПРАВДУ — «Файл отсутствует» во второй ячейке и
  // «Создание нового модуля» в третьей, — и виток был убит как за сочинённый отчёт:
  // словарь знал только «нов…» и смотрел лишь первые две ячейки. Честный отчёт обязан
  // проходить, иначе проверка ловит нас, а не модель.
  it('«Файл отсутствует» в одной ячейке и «нового» в другой — путь объявлен будущим', () => {
    writeArtifact(paths.explorationReport, [
      '# Отчёт разведки', '## Карта кодовой базы',
      '| Путь от корня | Что там сейчас | Что меняем |', '|---|---|---|',
      '| `src/oversize.ts` | Файл отсутствует | Создание нового модуля негабарита |',
    ].join('\n'));
    const r = checkPreconditions(stageById('ask'), ctx);
    ok(!r.problems.some((p) => /несуществующие пути/.test(p)), r.problems.join('; '));
  });

  it('«будет создан» и «не существует» — тоже пометки будущего файла', () => {
    for (const cell of ['будет создан на этапе 5', 'пока нет в дереве', 'не существует'] as const) {
      writeArtifact(paths.explorationReport, [
        '# Отчёт разведки', '## Карта кодовой базы',
        '| Путь от корня | Что там сейчас | Что меняем |', '|---|---|---|',
        `| src/новый-модуль.ts | ${cell} | реализовать |`,
      ].join('\n'));
      const r = checkPreconditions(stageById('ask'), ctx);
      ok(!r.problems.some((p) => /несуществующие пути/.test(p)), `${cell}: ${r.problems.join('; ')}`);
    }
  });

  it('путь без единой пометки по-прежнему считается сочинённым', () => {
    // Расширение словаря меняет размер дыры, а не её наличие: строка, которая ничего не
    // говорит о будущем файле, остаётся признаком отчёта, написанного не по коду.
    writeArtifact(paths.explorationReport, [
      '# Отчёт разведки', '## Карта кодовой базы',
      '| Путь от корня | Что там сейчас | Что меняем |', '|---|---|---|',
      '| frontend/components/undo-toast.jsx | тост отмены | расширить |',
    ].join('\n'));
    const r = checkPreconditions(stageById('ask'), ctx);
    ok(r.problems.some((p) => /несуществующие пути/.test(p)), r.problems.join('; '));
  });

  // Регрессия: сама форма методологии пишет `- **passed:** true`, а прежний regex не
  // переваривал markdown-жирность — канонический зелёный отчёт не открывал передачу.
  it('канонический зелёный отчёт (`- **passed:** true`) открывает передачу', () => {
    writeArtifact(
      paths.verificationReport(ctx.chunk, ctx.attempt),
      '# Отчёт приёмки\n\n## Вердикт\n\n- **passed:** true\n- **action:** continue\n',
    );
    const r = checkPreconditions(stageById('handoff'), ctx);
    ok(
      !r.problems.some((p) => /не passed=true/.test(p)),
      r.problems.join('; '),
    );
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

/**
 * Плейсхолдер внутри кода — пример, а не пустое поле (находка P5 ретро 2026-08-28:
 * ячейка набора, объясняющая сканирование плейсхолдеров, роняла шесть витков из шести).
 */
describe('плейсхолдеры и код', () => {
  it('инлайн-код не считается незаполненным местом', () => {
    strictEqual(countPlaceholders('гейт считает `grep -c ‹` по добавленным строкам'), 0);
  });

  // Обратная сторона: в тройных ограждениях формы методологии держат НАСТОЯЩИЕ поля —
  // вся машиночитаемая шапка handoff'а (slug, branch, base_sha, commit, verdict…) лежит
  // в ```-блоке. Пока их гасили, документ с пустой шапкой показывал «дыр: 0».
  it('поле внутри блока кода считается: формы держат там настоящие поля', () => {
    const text = ['Шапка передачи:', '', '```', '- **Кто:** ‹имя›', '```', ''].join('\n');
    strictEqual(countPlaceholders(text), 1);
  });

  it('настоящее незаполненное место рядом с кодом всё ещё считается', () => {
    const text = 'Команда `npm test`, утвердил: ‹имя›';
    strictEqual(countPlaceholders(text), 1);
  });

  it('незакрытая кавычка не глотает остаток документа', () => {
    const text = 'строка с ` одной кавычкой\n- **Кто:** ‹имя›';
    strictEqual(countPlaceholders(text), 1);
  });
});

describe('плейсхолдеры без секции', () => {
  it('плейсхолдер внутри названной секции не считается', () => {
    const text = '## Что придётся тронуть\n- ‹path/to/file› — ‹что здесь меняем›\n';
    strictEqual(countPlaceholdersExceptSections(text, ['Что придётся тронуть']), 0);
  });

  it('плейсхолдер вне названной секции считается как обычно', () => {
    const text = '## Коротко\n‹что делаем›\n\n## Что придётся тронуть\n- ‹path/to/file›\n';
    strictEqual(countPlaceholdersExceptSections(text, ['Что придётся тронуть']), 1);
  });

  it('секция обрывается на следующем заголовке того же уровня', () => {
    const text = '## Что придётся тронуть\n- ‹path/to/file›\n\n## Открытые вопросы\n‹кто ответит›\n';
    strictEqual(countPlaceholdersExceptSections(text, ['Что придётся тронуть']), 1);
  });

  it('отсутствующая секция не роняет подсчёт', () => {
    const text = '## Коротко\n‹что делаем›\n';
    strictEqual(countPlaceholdersExceptSections(text, ['Что придётся тронуть']), 1);
  });
});

// Регрессия: живой контрольный прогон бенчмарка объявлял поле «Ветка витка» как
// «sdlc/oversize (уже заведена)» / «sdlc/oversize (заведена заранее, зафиксирована в
// task.md)» — модель добавляла пояснение в скобках, как сделал бы и человек в интервью.
// `branchMismatchBlocker` сравнивал это ЦЕЛИКОМ с `git branch --show-current` и блокировал
// этап 4 на собственной пунктуации поля, а не на реальном расхождении с деревом.
describe('имя ветки из поля «Ветка витка»', () => {
  it('голое имя ветки возвращается как есть', () => {
    strictEqual(branchNameFromField('sdlc/oversize'), 'sdlc/oversize');
  });

  it('пояснение в скобках отбрасывается', () => {
    strictEqual(branchNameFromField('sdlc/oversize (уже заведена)'), 'sdlc/oversize');
  });

  it('пояснение в скобках без пробела перед ним тоже отбрасывается', () => {
    strictEqual(
      branchNameFromField('sdlc/oversize (заведена заранее, зафиксирована в task.md)'),
      'sdlc/oversize',
    );
  });

  it('внешние пробелы не влияют на результат', () => {
    strictEqual(branchNameFromField('  sdlc/oversize  '), 'sdlc/oversize');
  });

  it('markdown-бэктики вокруг имени отбрасываются', () => {
    strictEqual(branchNameFromField('`sdlc/oversize`'), 'sdlc/oversize');
  });
});
