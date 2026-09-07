import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { AXES, parsePlanAxes, planAxisProblems } from '../src/artifacts/planAxes.ts';
import type { AxisContext } from '../src/artifacts/planAxes.ts';
import { hasNamedInvariants } from '../src/artifacts/artifact.ts';
import { loadConfig } from '../src/config/load.ts';

/** Кейсы по эталону пропускаются с названной причиной — конвенция набора. */
function нетЭталона(dir: string): string | false {
  return existsSync(dir) ? false : `нет эталона методологии на этой машине: ${dir}`;
}

const NL = '\n';

/** Строка таблицы осей. */
function ось(name: string, affected: string, outcome: string): string {
  return `| ${name} | ${affected} | шаг 1: что-то | ${outcome} |`;
}

/** Строка таблицы принятых рисков — подписи в ней нет по построению формы. */
function риск(axis: string, revisit = 'первый инцидент'): string {
  return `| ${axis} | что-то ломается | пока допустимо | ${revisit} |`;
}

function план(rows: string[], risks: string[] = []): string {
  const блокРисков =
    risks.length === 0
      ? []
      : ['', '| Ось | Риск словами | Почему принимаем | Когда вернуться |', '|---|---|---|---|', ...risks];
  return [
    '# План: тест',
    '',
    '## Последствия шагов',
    '',
    '| Ось | Затронута шагами | Что именно в шагах | Исход |',
    '|---|---|---|---|',
    ...rows,
    ...блокРисков,
    '',
    '## Необратимые шаги',
    '',
    '- н/п',
    '',
  ].join(NL);
}

/** Канон, где все оси закрыты «н/п», кроме одной подменённой. */
function каноnСоСтрокой(axis: string, affected: string, outcome: string, risks: string[] = []): string {
  return план(
    AXES.map((a) => (a === axis ? ось(a, affected, outcome) : ось(a, 'нет', 'н/п — не затронута'))),
    risks,
  );
}

/** Полный контекст адресатов: всё, на что может сослаться исход, существует. */
const ПОЛНЫЙ: AxisContext = {
  claimIds: ['claim-1', 'claim-4'],
  enabledGates: ['Секреты в diff', 'Тесты'],
  hasOpenQuestion: true,
  hasInvariants: true,
};

function полныйПлан(): string {
  return план(
    [
      ось('Безопасность', 'да', 'claim-4'),
      ось('Ресурсы и скорость', 'да', 'инвариант «время ответа не растёт»'),
      ось('Отказы зависимостей', 'нет', 'н/п — новых внешних вызовов шаги не вводят'),
      ось('Настройки', 'нет', 'н/п — новых настроек нет'),
      ось('Совместимость и данные', 'да', 'гейт «Секреты в diff»'),
      ось('Наблюдаемость', 'да', 'риск'),
    ],
    [риск('Наблюдаемость')],
  );
}

describe('разбор последствий: словарь исходов', () => {
  it('полностью разобранная секция проблем не даёт', () => {
    deepStrictEqual(planAxisProblems(полныйПлан(), ПОЛНЫЙ), []);
  });

  it('исходы распознаются все шесть', () => {
    const parsed = parsePlanAxes(полныйПлан());
    deepStrictEqual(
      parsed.rows.map((r) => r.outcome),
      ['claim', 'invariant', 'notApplicable', 'notApplicable', 'gate', 'risk'],
    );
  });

  it('класс исхода берётся по первому ключевому слову, а не по порядку проверок', () => {
    // Ревью: фиксированный порядок читал все три случая неверно — «гейт … риск закрыт»
    // как risk, «риск — см. claim-3» как claim, «следующий виток … риск» как risk.
    const cases: [string, string][] = [
      ['гейт «Секреты в diff» — риск утечки закрыт', 'gate'],
      ['риск — см. claim-3', 'risk'],
      ['следующий виток: вопрос 4 — оценить риск утечки ключа', 'nextWitok'],
      ['исход: н/п — новых настроек нет', 'notApplicable'],
    ];
    for (const [cell, want] of cases) {
      const parsed = parsePlanAxes(план([ось('Безопасность', 'да', cell)]));
      strictEqual(parsed.rows[0]?.outcome, want, cell);
    }
  });

  it('«рискованно» словом «риск» не является', () => {
    const parsed = parsePlanAxes(план([ось('Безопасность', 'да', 'рискованно, но допустимо')]));
    strictEqual(parsed.rows[0]?.outcome, 'unknown');
  });

  it('свободный текст исходом не является', () => {
    const problems = planAxisProblems(
      каноnСоСтрокой('Безопасность', 'да', 'стоит подумать о валидации входа'),
      ПОЛНЫЙ,
    );
    strictEqual(problems.length, 1);
    ok(problems[0]?.includes('исход не из словаря'), problems[0]);
  });

  it('«н/п» без причины решением не считается', () => {
    ok(
      planAxisProblems(каноnСоСтрокой('Безопасность', 'нет', 'н/п'), ПОЛНЫЙ).some((p) =>
        p.includes('без причины'),
      ),
    );
  });

  it('затронутая ось не закрывается пометкой «не применимо»', () => {
    ok(
      planAxisProblems(каноnСоСтрокой('Безопасность', 'да', 'н/п — потом'), ПОЛНЫЙ).some((p) =>
        p.includes('объявлена затронутой'),
      ),
    );
  });

  it('незатронутая ось с решением — расхождение колонок', () => {
    ok(
      planAxisProblems(каноnСоСтрокой('Безопасность', 'нет', 'claim-1'), ПОЛНЫЙ).some((p) =>
        p.includes('объявлена незатронутой'),
      ),
    );
  });
});

describe('разбор последствий: адресат исхода', () => {
  it('claim-N, которого нет в задаче, исходом не является', () => {
    const problems = planAxisProblems(каноnСоСтрокой('Безопасность', 'да', 'claim-99'), ПОЛНЫЙ);
    ok(problems.some((p) => p.includes('claim-99') && p.includes('дописывает человек')), problems.join('; '));
  });

  it('гейт, которого нет среди включённых строк набора, исходом не является', () => {
    const problems = planAxisProblems(
      каноnСоСтрокой('Настройки', 'да', 'гейт «Такого нет»'),
      ПОЛНЫЙ,
    );
    ok(problems.some((p) => p.includes('Такого нет')), problems.join('; '));
  });

  it('гейт без имени в кавычках сверить нечем', () => {
    ok(
      planAxisProblems(каноnСоСтрокой('Настройки', 'да', 'включим гейт'), ПОЛНЫЙ).some((p) =>
        p.includes('имя гейта не названо'),
      ),
    );
  });

  it('«следующий виток» без открытого вопроса в задаче исходом не является', () => {
    const problems = planAxisProblems(каноnСоСтрокой('Наблюдаемость', 'да', 'следующий виток'), {
      ...ПОЛНЫЙ,
      hasOpenQuestion: false,
    });
    ok(problems.some((p) => p.includes('нет ни одного открытого')), problems.join('; '));
  });

  it('«инвариант» без инвариантов в задаче исходом не является', () => {
    const problems = planAxisProblems(каноnСоСтрокой('Безопасность', 'да', 'инвариант держится'), {
      ...ПОЛНЫЙ,
      hasInvariants: false,
    });
    ok(problems.some((p) => p.includes('не назван ни один инвариант')), problems.join('; '));
  });

  it('без контекста адресаты не проверяются — разбор зовут и по одному артефакту', () => {
    deepStrictEqual(planAxisProblems(каноnСоСтрокой('Безопасность', 'да', 'claim-99')), []);
  });

  it('весь канон, закрытый несуществующими адресатами, проблемы даёт', () => {
    // Ровно тот план, на котором прежняя версия возвращала ноль проблем (ревью).
    const text = план([
      ось('Безопасность', 'да', 'claim-99'),
      ось('Ресурсы и скорость', 'да', 'гейт «Такого нет»'),
      ось('Отказы зависимостей', 'да', 'следующий виток'),
      ось('Настройки', 'да', 'инвариант «что угодно»'),
      ось('Совместимость и данные', 'да', 'claim-77'),
      ось('Наблюдаемость', 'да', 'риск'),
    ]);
    const problems = planAxisProblems(text, {
      claimIds: ['claim-1'],
      enabledGates: ['Тесты'],
      hasOpenQuestion: false,
      hasInvariants: false,
    });
    strictEqual(problems.length, 6, problems.join(NL));
  });
});

describe('разбор последствий: принятый риск', () => {
  it('исход «риск» без строки в таблице рисков не проходит', () => {
    ok(
      planAxisProblems(каноnСоСтрокой('Безопасность', 'да', 'риск'), ПОЛНЫЙ).some((p) =>
        p.includes('нет в таблице принятых'),
      ),
    );
  });

  it('риск без срока пересмотра — забывание, а не решение', () => {
    const text = каноnСоСтрокой('Безопасность', 'да', 'риск', [риск('Безопасность', '')]);
    ok(planAxisProblems(text, ПОЛНЫЙ).some((p) => p.includes('Когда вернуться')));
  });

  it('риск с причиной и сроком проходит — подписи в строке не требуется', () => {
    // Подпись здесь и не может стоять: риски человек принимает полем «Одобрение» плана.
    const text = каноnСоСтрокой('Безопасность', 'да', 'риск', [риск('Безопасность')]);
    deepStrictEqual(planAxisProblems(text, ПОЛНЫЙ), []);
  });

  it('строка риска без оси-владельца — след недоправленной секции', () => {
    const text = каноnСоСтрокой('Безопасность', 'нет', 'н/п — не затронута', [риск('Безопасность')]);
    ok(planAxisProblems(text, ПОЛНЫЙ).some((p) => p.includes('исход этой оси — не «риск»')));
  });

  it('потерянная шапка таблицы рисков не превращает её в оси', () => {
    // Ревью: подписанный риск давал три ложные претензии сразу.
    const text = [
      '# План: тест',
      '',
      '## Последствия шагов',
      '',
      '| Ось | Затронута шагами | Что именно | Исход |',
      '|---|---|---|---|',
      ...AXES.map((a) => ось(a, a === 'Безопасность' ? 'да' : 'нет', a === 'Безопасность' ? 'риск' : 'н/п — не затронута')),
      '',
      риск('Безопасность'),
      '',
    ].join(NL);
    const parsed = parsePlanAxes(text);
    strictEqual(parsed.rows.length, 6);
    strictEqual(parsed.risks.length, 1);
    deepStrictEqual(planAxisProblems(text, ПОЛНЫЙ), []);
  });
});

describe('разбор последствий: форма таблицы', () => {
  it('пропущенная ось канона названа по имени', () => {
    const problems = planAxisProblems(
      план([ось('Безопасность', 'нет', 'н/п — внешнего входа нет')]),
      ПОЛНЫЙ,
    );
    ok(problems.some((p) => p.includes('Наблюдаемость') && p.includes('нет строк для осей')));
  });

  it('дубль строки одной оси ловится', () => {
    const text = план([
      ...AXES.map((a) => ось(a, 'нет', 'н/п — не затронута')),
      ось('Безопасность', 'да', 'claim-1'),
    ]);
    ok(planAxisProblems(text, ПОЛНЫЙ).some((p) => p.includes('разобрана 2 раза')));
  });

  it('ось со скобочным уточнением остаётся канонической', () => {
    const parsed = parsePlanAxes(план([ось('Безопасность (входные данные)', 'да', 'claim-1')]));
    strictEqual(parsed.rows[0]?.canonical, 'Безопасность');
  });

  it('колонки читаются по шапке, а не по позиции', () => {
    const text = [
      '## Последствия шагов',
      '',
      '| Ось | Затронута шагами | Что именно | Кто закрывает | Исход |',
      '|---|---|---|---|---|',
      ...AXES.map((a) => `| ${a} | нет | шаг 1 | человек | н/п — не затронута |`),
      '',
    ].join(NL);
    deepStrictEqual(planAxisProblems(text, ПОЛНЫЙ), []);
  });

  it('чужая секция «Последствия для клиентов» в разбор не затягивается', () => {
    const text = [
      план(AXES.map((a) => ось(a, 'нет', 'н/п — не затронута'))),
      '## Последствия для клиентов',
      '',
      '| Клиент | Что меняется | Когда |',
      '|---|---|---|',
      '| Мобильный | цена | в релизе |',
      '',
    ].join(NL);
    strictEqual(parsePlanAxes(text).rows.length, 6);
    deepStrictEqual(planAxisProblems(text, ПОЛНЫЙ), []);
  });

  it('плейсхолдер в инлайн-коде пустой ячейкой не считается', () => {
    // Общий `hasPlaceholder` гасит `‹…›` внутри обратных кавычек — иначе артефакт был бы
    // «готов» для финализации и «пуст» для оси одновременно (ревью).
    const text = каноnСоСтрокой('Настройки', 'нет', 'н/п — плейсхолдеров `‹…›` в шагах нет');
    deepStrictEqual(planAxisProblems(text, ПОЛНЫЙ), []);
  });

  it('незаполненная колонка «Затронута» — не «нет», а отсутствие ответа', () => {
    ok(
      planAxisProblems(каноnСоСтрокой('Безопасность', '‹да/нет›', 'н/п — нет'), ПОЛНЫЙ).some((p) =>
        p.includes('не заполнена'),
      ),
    );
  });

  it('своя ось проекта разбирается наравне с каноническими', () => {
    const text = план([
      ...AXES.map((a) => ось(a, 'нет', 'н/п — не затронута')),
      ось('Локализация', 'да', 'вольный текст без исхода'),
    ]);
    ok(planAxisProblems(text, ПОЛНЫЙ).some((p) => p.includes('Локализация')));
  });

  it('секции нет вовсе — это дыра, а не пустой разбор', () => {
    const problems = planAxisProblems('# План: тест\n\n## Шаги\n\n1. что-то\n', ПОЛНЫЙ);
    strictEqual(problems.length, 1);
    ok(problems[0]?.includes('нет секции'));
  });
});

describe('инварианты задачи', () => {
  it('«н/п — проектных инвариантов нет» инвариантом не является', () => {
    strictEqual(
      hasNamedInvariants(['## Инварианты', '', '- н/п — проектных инвариантов нет', '', '## Дальше'].join(NL)),
      false,
    );
  });

  it('названный инвариант виден', () => {
    strictEqual(
      hasNamedInvariants(['## Инварианты', '', '- форма Quote не меняется — проверяется тестом X', ''].join(NL)),
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// Прогон по реальным артефактам эталона
// ---------------------------------------------------------------------------

const cfg = loadConfig();
const methodology = cfg.runner.methodologyDir;

describe('разбор последствий: эталон', { skip: нетЭталона(methodology) }, () => {
  const intent = () => readFileSync(join(methodology, 'example', 'intent.md'), 'utf8');
  const ctxПримера = (): AxisContext => {
    const text = intent();
    const ids = text
      .split(/\r?\n/)
      .map((l) => /^\s*\|\s*`?(claim-\d+)/.exec(l)?.[1])
      .filter((id): id is string => id !== undefined);
    return {
      claimIds: ids,
      enabledGates: ['Разбор последствий', 'Секреты в diff', 'Готовность задачи', 'Интеграционные тесты'],
      hasOpenQuestion: /^\s*[-*+]\s*\[\s*\]/m.test(text),
      hasInvariants: hasNamedInvariants(text),
    };
  };

  it('заполненный пример плана проходит проверку целиком', () => {
    const text = readFileSync(join(methodology, 'example', 'plan.md'), 'utf8');
    deepStrictEqual(planAxisProblems(text, ctxПримера()), []);
  });

  it('пустой бланк проверку не проходит — иначе форма считалась бы работой', () => {
    const text = readFileSync(join(methodology, 'templates', 'plan.template.md'), 'utf8');
    ok(planAxisProblems(text, ПОЛНЫЙ).length > 0);
  });

  it('в примере задачи названы инварианты и есть открытый вопрос', () => {
    const ctx = ctxПримера();
    strictEqual(ctx.hasInvariants, true);
    strictEqual(ctx.hasOpenQuestion, true);
    ok((ctx.claimIds ?? []).length >= 3);
  });
});
