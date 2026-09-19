import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { readFileSync, existsSync} from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
/**
 * Эталон методологии — чужой каталог на машине оператора (`methodologyDir`/`skillsDir` из
 * конфига), и на другой машине его просто нет. Такие кейсы ПРОПУСКАЮТСЯ с названной
 * причиной, а не остаются вечно красными: набор, красный по умолчанию, приучает себя
 * игнорировать, и настоящая регрессия в нём не видна. Там, где эталон есть, они работают
 * как раньше. Герметичный двойник для сборки промпта — `promptEcosystem.test.ts`.
 */
function нетЭталона(dir: string): string | false {
  return existsSync(dir) ? false : `нет эталона методологии на этой машине: ${dir}`;
}


import {
  addedBeyondPlanPaths,
  appendScopeExtension,
  excludedFromPlanPaths,
  extractFilesToTouch,
  seedFilesToTouch,
  touchListEntries,
} from '../src/artifacts/planFiles.ts';
import { loadConfig } from '../src/config/load.ts';

describe('touchListEntries', () => {
  it('читает путь и заметку из бульита «Что придётся тронуть»', () => {
    const intent = [
      '## Что придётся тронуть',
      '_Заполняет агент на разведке._',
      '',
      '- src/tariffs.ts — добавить surcharge',
      '- src/oversize.ts — использовать surcharge',
      '',
      '## Открытые вопросы',
      '- src/never.ts — эта секция уже не «Что придётся тронуть»',
    ].join('\n');
    deepStrictEqual(touchListEntries(intent), [
      { path: 'src/tariffs.ts', note: 'добавить surcharge' },
      { path: 'src/oversize.ts', note: 'использовать surcharge' },
    ]);
  });

  it('строка-образец с плейсхолдером пропускается', () => {
    const intent = ['## Что придётся тронуть', '', '- ‹path/to/file› — ‹что здесь меняем›', ''].join('\n');
    deepStrictEqual(touchListEntries(intent), []);
  });

  it('секции нет — пустой список, не падение', () => {
    deepStrictEqual(touchListEntries('# Задача: демо\n\n## Коротко\n\nчто-то\n'), []);
  });

  it('путь в обратных кавычках — кавычки снимаются', () => {
    const intent = ['## Что придётся тронуть', '', '- `src/a.ts` — правка', ''].join('\n');
    deepStrictEqual(touchListEntries(intent), [{ path: 'src/a.ts', note: 'правка' }]);
  });
});

describe('excludedFromPlanPaths / addedBeyondPlanPaths', () => {
  it('извлекает пути из «Из задачи исключено»', () => {
    const plan = '- **Из задачи исключено**: `src/oversize.ts` — не понадобился\n';
    deepStrictEqual(excludedFromPlanPaths(plan), ['src/oversize.ts']);
  });

  it('извлекает пути из «Добавлено сверх разведки»', () => {
    const plan = '- **Добавлено сверх разведки:** `src/config.ts` — нужен флаг\n';
    deepStrictEqual(addedBeyondPlanPaths(plan), ['src/config.ts']);
  });

  // Регрессия ревью (2026-09-18), воспроизведена живым прогоном против реального
  // plan.template.md: «Добавлено сверх разведки» стоит СРАЗУ перед «Из задачи исключено»,
  // без заголовка между ними. Регион первой метки раньше тянулся до следующего ЗАГОЛОВКА
  // и захватывал весь текст второй метки — путь, упомянутый в объяснении исключения,
  // засчитывался как уже объяснённое добавление (и наоборот), хотя строка «Добавлено
  // сверх разведки» буквально говорит «нет».

  it('не протекает из «Добавлено сверх разведки» в соседнее «Из задачи исключено»', () => {
    const plan = [
      '- **Добавлено сверх разведки:** нет',
      '- **Из задачи исключено** _(в `files_to_touch` не входит — иначе scope-проверка разрешила бы',
      '  правку в файле, который трогать не собирались)_: `src/oversize.ts` — логика перенесена в `src/config.ts`',
      '',
      '## Затронутые вызовы/сигнатуры',
    ].join('\n');
    deepStrictEqual(addedBeyondPlanPaths(plan), [], 'метка сказала «нет» — добавленных путей быть не должно');
    deepStrictEqual(excludedFromPlanPaths(plan), ['src/oversize.ts', 'src/config.ts']);
  });

  it('не протекает из «Из задачи исключено» в следующую метку того же вида', () => {
    const plan = [
      '- **Из задачи исключено**: `src/oversize.ts` — не понадобился',
      '- **Добавлено сверх разведки:** `src/config.ts` — нужен флаг',
    ].join('\n');
    deepStrictEqual(excludedFromPlanPaths(plan), ['src/oversize.ts']);
    deepStrictEqual(addedBeyondPlanPaths(plan), ['src/config.ts']);
  });

  it('метки нет — пустой список', () => {
    deepStrictEqual(excludedFromPlanPaths('# План\n'), []);
    deepStrictEqual(addedBeyondPlanPaths('# План\n'), []);
  });

  it('метка есть, путей после неё нет («нет») — пустой список', () => {
    deepStrictEqual(excludedFromPlanPaths('- **Из задачи исключено**: нет\n'), []);
  });

  // Регрессия ревью (2026-09-19), воспроизведена выполнением кода: вложенный, с отступом,
  // суб-буллет того же вида («  - **Причина:**») засчитывался за границу региона наравне с
  // соседней меткой ВЕРХНЕГО уровня — путь, названный ПОСЛЕ такого суб-буллета, терялся.

  it('вложенный суб-буллет («  - **…») не обрывает регион метки — путь после него не теряется', () => {
    const plan = [
      '- **Из задачи исключено**: экономия — файлы ниже:',
      '  - `src/a.ts` — не пригодился',
      '  - **Важно:** решение принято по итогам ревью',
      '  - `src/b.ts` — тоже не пригодился',
      '- **Добавлено сверх разведки:** нет',
    ].join('\n');
    deepStrictEqual(excludedFromPlanPaths(plan), ['src/a.ts', 'src/b.ts']);
  });

  it('не заходит за следующий заголовок', () => {
    const plan = [
      '- **Добавлено сверх разведки:** `src/config.ts` — нужен флаг',
      '',
      '## Затронутые вызовы/сигнатуры',
      '',
      '| `src/never.ts` | эта таблица уже не про files_to_touch |',
    ].join('\n');
    deepStrictEqual(addedBeyondPlanPaths(plan), ['src/config.ts']);
  });
});

describe('files_to_touch', () => {
  it('читает пути из таблицы плана', () => {
    const plan = [
      '## files_to_touch',
      '',
      '| Путь | Что делаем |',
      '|---|---|',
      '| `src/a.java` | обёртка |',
      '| `src/b.java` | заголовок |',
      '',
      '## Чем закрывается',
      '| `src/never.java` | эта секция уже не про allowlist |',
    ].join('\n');
    deepStrictEqual(extractFilesToTouch(plan), ['src/a.java', 'src/b.java']);
  });

  it('не тащит в allowlist пути из «Из задачи исключено»', () => {
    // Расширить allowlist этими путями значило бы разрешить правку в файле, который
    // трогать не собирались, — методология это запрещает прямым текстом.
    const plan = [
      '## files_to_touch',
      '| Путь | Что делаем |',
      '|---|---|',
      '| `src/a.java` | правим |',
      '',
      '- **Добавлено сверх разведки:** `src/extra.java` — понадобился под claim-3',
      '- **Из задачи исключено:** `src/skipped.java` — не понадобился',
      '',
      '## Дальше',
    ].join('\n');
    const files = extractFilesToTouch(plan);
    deepStrictEqual(files, ['src/a.java', 'src/extra.java']);
  });

  it('пустой план даёт пустой список — PlanScope тогда выключен', () => {
    deepStrictEqual(extractFilesToTouch('# План\nбез секции'), []);
  });

  it('плейсхолдеры формы путями не считаются', () => {
    const plan = '## files_to_touch\n| Путь | Что делаем |\n|---|---|\n| ‹path/to/file› | ‹что делаем› |\n';
    deepStrictEqual(extractFilesToTouch(plan), []);
  });

  it('артефакты процесса в allowlist не попадают', () => {
    const plan = '## files_to_touch\n| `.sdlc/demo/plan.md` | нет |\n| `src/a.ts` | да |\n';
    deepStrictEqual(extractFilesToTouch(plan), ['src/a.ts']);
  });

  it('проза без обратных кавычек не становится путём', () => {
    const plan = '## files_to_touch\n\nсписок совпал с разведкой, менять нечего\n';
    deepStrictEqual(extractFilesToTouch(plan), []);
  });

  it('appendScopeExtension дописывает путь после «Добавлено сверх разведки»', () => {
    const plan = [
      '## files_to_touch',
      '| Путь | Что делаем |',
      '|---|---|',
      '| `src/a.java` | правим |',
      '',
      '- **Добавлено сверх разведки:** нет',
      '- **Из задачи исключено:** нет',
      '',
      '## Дальше',
    ].join('\n');
    const updated = appendScopeExtension(plan, 'src/extra.java', 'расширено на этапе chunk · Иван · 2026-08-23 — понадобился под claim-3');
    ok(updated !== null);
    ok(updated.includes('src/extra.java'));
    // Дописанный путь обязан реально попасть в allowlist — не просто лечь строкой в файл,
    // а быть виден тому же парсеру, который читает files_to_touch для PlanScope.
    deepStrictEqual(extractFilesToTouch(updated), ['src/a.java', 'src/extra.java']);
  });

  it('appendScopeExtension — null, если в plan.md нет строки «Добавлено сверх разведки»', () => {
    const plan = '## files_to_touch\n| `src/a.java` | правим |\n';
    strictEqual(appendScopeExtension(plan, 'src/extra.java', 'причина'), null);
  });

  it('appendScopeExtension — вторая запись встаёт ПОСЛЕ первой, не между маркером и ней', () => {
    // Регресс на LIFO: раньше каждая вставка матчила статичный маркер, а не последнюю уже
    // добавленную строку, и порядок в plan.md получался обратным хронологии одобрений.
    const plan = [
      '## files_to_touch',
      '| `src/a.java` | правим |',
      '',
      '- **Добавлено сверх разведки:** нет',
      '- **Из задачи исключено:** нет',
    ].join('\n');
    const afterFirst = appendScopeExtension(plan, 'src/first.java', 'первая');
    ok(afterFirst !== null);
    const afterSecond = appendScopeExtension(afterFirst, 'src/second.java', 'вторая');
    ok(afterSecond !== null);

    const firstAt = afterSecond.indexOf('src/first.java');
    const secondAt = afterSecond.indexOf('src/second.java');
    ok(firstAt >= 0 && secondAt >= 0);
    ok(firstAt < secondAt, `порядок должен быть хронологическим: first=${firstAt}, second=${secondAt}`);
    deepStrictEqual(extractFilesToTouch(afterSecond), ['src/a.java', 'src/first.java', 'src/second.java']);
  });

  it('артефакт витка, помянутый в прозе секции, путём плана не становится (r21)', () => {
    // Живой план: «**Добавлено сверх разведки:** нет — список совпадает с … из `intent.md`».
    // Упоминание давало ЧЕТВЁРТЫЙ путь: PlanScope выдавал право писать в артефакт человека,
    // а гейт «Scope: пути плана без правок» краснел на пути, который никто не правит, —
    // вердикт не мог позеленеть в принципе.
    const plan = [
      '## files_to_touch',
      '',
      '| Путь | Что делаем |',
      '|---|---|',
      '| `src/a.ts` | правка |',
      '',
      '- **Добавлено сверх разведки:** нет — список совпадает с «Что придётся тронуть» из `intent.md`',
      '- Пункты приёмки перенесены из `readiness.md`, журнал витка — `chunk-1-journal.md`',
      '',
    ].join('\n');
    deepStrictEqual(extractFilesToTouch(plan), ['src/a.ts']);
  });

  it('живой пример методологии разбирается целиком', { skip: нетЭталона(loadConfig().runner.methodologyDir) }, () => {
    const cfg = loadConfig();
    const example = join(cfg.runner.methodologyDir, 'example', 'plan.md');
    const files = extractFilesToTouch(readFileSync(example, 'utf8'));
    deepStrictEqual(files, [
      'src/main/java/com/acme/payments/service/PaymentService.java',
      'src/main/java/com/acme/payments/web/PaymentController.java',
      'src/main/java/com/acme/payments/schedule/PaymentRetryScheduler.java',
      'src/test/java/com/acme/payments/PaymentIdempotencyIT.java',
    ]);
  });
});

describe('seedFilesToTouch (4.1, засев до хода модели)', () => {
  const PLAN = [
    '## files_to_touch',
    '',
    '| Путь | Что делаем |',
    '|---|---|',
    '| ‹path/to/file› | ‹что делаем› |',
    '',
    '- **Добавлено сверх разведки:** ‹path — потому что …› / нет',
    '- **Из задачи исключено**: ‹path — почему не понадобился› / нет',
    '',
    '## Дальше',
  ].join('\n');

  it('засевает строки из «Что придётся тронуть», путь и заметка переносятся', () => {
    const touch = [
      { path: 'src/tariffs.ts', note: 'добавить surcharge' },
      { path: 'src/oversize.ts', note: 'использовать surcharge' },
    ];
    const { text, seeded } = seedFilesToTouch(PLAN, touch);
    strictEqual(seeded, 2);
    deepStrictEqual(extractFilesToTouch(text), ['src/tariffs.ts', 'src/oversize.ts']);
    ok(text.includes('| `src/tariffs.ts` | добавить surcharge |'), text);
    ok(text.includes('| `src/oversize.ts` | использовать surcharge |'), text);
    ok(!text.includes('‹path/to/file›'), 'строка-образец обязана быть заменена');
  });

  it('заметки разведки нет — вторая ячейка остаётся плейсхолдером для модели', () => {
    const { text } = seedFilesToTouch(PLAN, [{ path: 'src/a.ts', note: '' }]);
    ok(text.includes('| `src/a.ts` | ‹что делаем› |'), text);
  });

  it('соседняя метка «Добавлено сверх разведки» не трогается', () => {
    const { text } = seedFilesToTouch(PLAN, [{ path: 'src/a.ts', note: 'правка' }]);
    ok(text.includes('- **Добавлено сверх разведки:** ‹path — потому что …› / нет'), text);
    ok(text.includes('- **Из задачи исключено**: ‹path — почему не понадобился› / нет'), text);
    ok(text.includes('## Дальше'), text);
  });

  it('идемпотентно: в таблице уже есть настоящий путь — засев не срабатывает', () => {
    const already = '## files_to_touch\n| Путь | Что делаем |\n|---|---|\n| `src/kept.ts` | руками |\n';
    const { text, seeded } = seedFilesToTouch(already, [{ path: 'src/tariffs.ts', note: 'x' }]);
    strictEqual(seeded, 0);
    strictEqual(text, already);
  });

  it('«Что придётся тронуть» пуст — засевать нечем, план не трогается', () => {
    const { text, seeded } = seedFilesToTouch(PLAN, []);
    strictEqual(seeded, 0);
    strictEqual(text, PLAN);
  });

  it('дубль пути в «Что придётся тронуть» — одна строка, не две', () => {
    const touch = [
      { path: 'src/a.ts', note: 'первое упоминание' },
      { path: 'src/a.ts', note: 'второе упоминание' },
    ];
    const { text, seeded } = seedFilesToTouch(PLAN, touch);
    strictEqual(seeded, 1);
    deepStrictEqual(extractFilesToTouch(text), ['src/a.ts']);
  });

  it('таблицы в тексте нет вовсе — no-op, не падение', () => {
    const noTable = '## files_to_touch\n\nсвободный текст без таблицы\n';
    const { text, seeded } = seedFilesToTouch(noTable, [{ path: 'src/a.ts', note: 'x' }]);
    strictEqual(seeded, 0);
    strictEqual(text, noTable);
  });

  it('засеянные пути проходят засевом plan → discrepancy-гейт их видит как «оставлены»', () => {
    // Интеграция с 4.1 «М»-половиной (planTouchDiscrepancyProblem): засеянный путь не
    // считается расхождением сам по себе — он тот же путь, что и в «Что придётся тронуть».
    const { text } = seedFilesToTouch(PLAN, [{ path: 'src/a.ts', note: 'правка' }]);
    deepStrictEqual(extractFilesToTouch(text), ['src/a.ts']);
  });
});
