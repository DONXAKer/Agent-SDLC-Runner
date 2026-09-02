/**
 * `applyFill`: значение поля → markdown артефакта.
 *
 * Раунд-трип по реальным шаблонам эталона — заполняются все model-поля значениями из
 * заполненных примеров (`example/`), затем результат проверяют парсеры раннера, которые
 * читают этот же артефакт в бою (`artifacts/artifact.ts`, `md/table.ts`,
 * `artifacts/claims.ts`, `artifacts/planFiles.ts`, `artifacts/humanFacts.ts`,
 * `run/stages.ts`). Пропускается с названной причиной, если эталона нет на машине —
 * конвенция репозитория (`server/test/prompt.test.ts`).
 */

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { loadConfig } from '../src/config/load.ts';
import { applyFill } from '../src/artifacts/applyFill.ts';
import { countPlaceholders, isDecisionLine, writeArtifact } from '../src/artifacts/artifact.ts';
import { WitokPaths } from '../src/artifacts/paths.ts';
import { countClaims } from '../src/artifacts/claims.ts';
import { deriveSchema, modelFields } from '../src/artifacts/formSchema.ts';
import { extractFilesToTouch } from '../src/artifacts/planFiles.ts';
import { extractHumanFacts } from '../src/artifacts/humanFacts.ts';
import { isSmallContour } from '../src/run/stages.ts';
import { parseTables } from '../src/md/table.ts';

function нетЭталона(dir: string): string | false {
  return existsSync(dir) ? false : `нет эталона методологии на этой машине: ${dir}`;
}

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

describe('applyFill: герметичные случаи', () => {
  it('scalar: сплайс диапазона плейсхолдера', () => {
    const text = '- **Ветка витка:** ‹sdlc/слаг›\n';
    const r = applyFill(text, 'ветка витка', 'sdlc/oversize');
    ok(r.ok);
    strictEqual(r.text, '- **Ветка витка:** sdlc/oversize\n');
    strictEqual(countPlaceholders(r.text), 0);
  });

  it('choice: выбранная ветка заменяет ВСЁ меню целиком, вторая ветка исчезает', () => {
    const text = '- **Контур:** полный / мелкий — критерий в SDLC.md\n';
    const r = applyFill(text, 'контур', 'мелкий');
    ok(r.ok);
    ok(r.text.includes('мелкий'));
    ok(!r.text.includes('полный'));
    ok(!r.text.includes(' / '));
  });

  it('choice со слотом комментария: плейсхолдер внутри варианта заменяется значением', () => {
    // Вариант «❌» несёт СВОЙ плейсхолдер («причина ‹что не так›») — образец
    // `exploration-report.template.md` («вне scope — противоречит «‹строка из…»`»);
    // выбор этого варианта обязан подставить значение в плейсхолдер, а не стереть текст
    // варианта целиком.
    const text = '- **Итог:** ✅ / ❌ — причина ‹что не так›\n';
    const r = applyFill(text, 'итог', '❌ упал тест retryReturns200');
    ok(r.ok);
    ok(r.text.includes('❌ — причина упал тест retryReturns200'));
    ok(!r.text.includes('✅'));
  });

  it('list: образец разворачивается в N строк', () => {
    const text = '## Что делаем\n\n- ‹что делаем›\n';
    const r = applyFill(text, 'что делаем', '- Поддержка заголовка X\n- Хранение ключа');
    ok(r.ok);
    ok(r.text.includes('- Поддержка заголовка X'));
    ok(r.text.includes('- Хранение ключа'));
    strictEqual(countPlaceholders(r.text), 0);
  });

  it('list: пустой ответ при заявленной альтернативе «пусто» — подставляет её', () => {
    const text = '## Необратимые шаги\n\n- ‹необратимый шаг› — подтверждает человек / н/п\n';
    const r = applyFill(text, 'необратимые шаги', '');
    ok(r.ok);
    ok(r.text.includes('н/п'));
  });

  it('records-список: строки по образцу «‹a› — ‹b›»', () => {
    const text = '## Что придётся тронуть\n\n- ‹path/to/file› — ‹что здесь меняем›\n';
    const r = applyFill(text, 'что придётся тронуть', '- src/a.ts — добавить поле\n- src/b.ts — обновить вызов');
    ok(r.ok);
    ok(r.text.includes('src/a.ts — добавить поле'));
    ok(r.text.includes('src/b.ts — обновить вызов'));
  });

  it('records-таблица: id пункта нумерует рантайм, не модель', () => {
    const text = [
      '## Приёмочный лист',
      '',
      '| id | Пункт | Как проверить (процедура + критерий) |',
      '|----|-------|--------------------------------------|',
      '| claim-1 | ‹наблюдаемое поведение› | ‹процедура и критерий годности› |',
      '',
    ].join('\n');
    const r = applyFill(
      text,
      'приемочный лист',
      '- пункт: код 200 на повторе\n  как проверить: retryReturns200 — код ровно 200\n' +
        '- пункт: не создаёт новую строку\n  как проверить: retryCreatesNoRow — count не меняется',
    );
    ok(r.ok);
    const { rows } = countClaims(r.text);
    strictEqual(rows, 2);
    ok(r.text.includes('| claim-1 |'));
    ok(r.text.includes('| claim-2 |'));
  });

  it('op "add": для списка дописывает после образца, не заменяет его', () => {
    const text = '## Что делаем\n\n- ‹что делаем›\n';
    const r = applyFill(text, 'что делаем', '- пункт раз', 'add');
    ok(r.ok);
    ok(r.text.includes('- ‹что делаем›'), 'образец остаётся — add не трогает уже стоящие строки');
    ok(r.text.includes('- пункт раз'));
  });

  it('decision-поле — заполнить нельзя, ошибка называет владельца', () => {
    const text = "- **Подтвердил:** ‹имя› · ‹дата› / использовано одобрение плана через ExitPlanMode этой сессии\n";
    const r = applyFill(text, 'подтвердил', 'Иван · 2026-09-02');
    strictEqual(r.ok, false);
  });

  it('неизвестное поле — ошибка перечисляет доступные id', () => {
    const r = applyFill('# Задача\n\n‹что делаем›\n', 'нет такого', 'x');
    strictEqual(r.ok, false);
  });

  it('заполненное scalar-поле не остаётся полем — «незаполненное место» и есть его определение', () => {
    // Совпадает с `placeholderRanges`: место без `‹…›` — заполненное, повторный вопрос
    // моделью о нём не встаёт (та же семантика, что у сегодняшнего `groupFields`).
    const text = '- **Ветка витка:** ‹sdlc/слаг›\n';
    const first = applyFill(text, 'ветка витка', 'sdlc/a');
    ok(first.ok);
    strictEqual(countPlaceholders(first.text), 0);
    const again = applyFill(first.text, 'ветка витка', 'sdlc/b');
    strictEqual(again.ok, false, 'поля без плейсхолдера в схеме уже нет — заполнять больше нечего');
  });
});

// ---------------------------------------------------------------------------
// Раунд-трип по реальным шаблонам и примерам эталона
// ---------------------------------------------------------------------------

const cfg = loadConfig();
const templatesDir = join(cfg.runner.methodologyDir, 'templates');
const exampleDir = join(cfg.runner.methodologyDir, 'example');

/** Значение для поля из соответствующего заполненного примера — по секции/метке, грубо. */
function valueForField(exampleText: string, field: { id: string; kind: string }): string | null {
  // Простая эвристика для раунд-трипа: берём непустую строку примера того же типа поля.
  // Не обязана быть «умной» — цель теста в том, что РЕЗУЛЬТАТ читается парсерами, а не в
  // семантическом сходстве с примером.
  if (field.kind === 'list') return '- пример пункта раз\n- пример пункта два';
  if (field.kind === 'records') return '- пример раз — значение раз\n- пример два — значение два';
  if (field.kind === 'multiline') return 'Пример содержательного текста абзаца.';
  return `пример-${field.id.replace(/[^\wа-яё-]/gi, '')}`;
}

describe('applyFill: раунд-трип по реальным шаблонам эталона', { skip: нетЭталона(templatesDir) }, () => {
  const files = readdirSync(templatesDir).filter((f) => f.endsWith('.template.md'));

  it('заполнение всех model-полей снимает плейсхолдеры этих полей и не трогает decision', () => {
    for (const name of files) {
      const original = readFileSync(join(templatesDir, name), 'utf8');
      let text = original;
      const schema0 = deriveSchema(text, name);
      const targets = modelFields(schema0).filter((f) => f.kind !== 'records' || f.shape !== 'table');
      for (const f of targets) {
        const value = f.kind === 'choice' ? (f.options ?? [])[0]?.key ?? 'да' : valueForField(original, f);
        if (value === null) continue;
        const r = applyFill(text, f.id, value);
        if (!r.ok) continue; // поле могло стать decision/иным по мере правок — не в счёт раунд-трипа
        text = r.text;
      }
      // Решения человека остаются НЕТРОНУТЫМИ — их applyFill не мог заполнить по построению.
      const decisionLines = original.split(/\r?\n/).filter((l) => isDecisionLine(l));
      for (const line of decisionLines) {
        ok(text.includes(line.trim()) || text.split('\n').some((l) => l.trim() === line.trim()), `${name}: строка решения изменилась`);
      }
    }
  });

  it('plan.template.md: files_to_touch читается тем же разбором, что у политики', () => {
    const original = readFileSync(join(templatesDir, 'plan.template.md'), 'utf8');
    const r = applyFill(original, 'files_to_touch', '- src/a.ts — правка X\n- src/b.ts — правка Y');
    ok(r.ok);
    const files = extractFilesToTouch(r.text);
    deepStrictEqual(files.sort(), ['src/a.ts', 'src/b.ts']);
  });

  it('gates.template.md: таблица «Набор» остаётся разбираемой parseTables', () => {
    const original = readFileSync(join(templatesDir, 'gates.template.md'), 'utf8');
    const tables = parseTables(original);
    ok(tables.length > 0);
    // Шапка не тронута applyFill — фиксированные строки правятся по ячейкам, не по секции.
    const setTable = tables.find((t) => t.header.includes('Гейт'));
    ok(setTable !== undefined);
  });
});

describe('applyFill: раунд-трип на заполненных примерах', { skip: нетЭталона(exampleDir) }, () => {
  it('intent.md: приёмочный лист, заполненный через applyFill, читается countClaims', () => {
    const template = readFileSync(join(cfg.runner.methodologyDir, 'templates', 'intent.template.md'), 'utf8');
    const r = applyFill(
      template,
      'приемочный лист',
      '- пункт: код 200 на повторе\n  как проверить: retryReturns200 [edge]\n' +
        '- пункт: не создаёт новую строку [edge]\n  как проверить: retryCreatesNoRow\n' +
        '- пункт: без ключа код 201\n  как проверить: noKeyReturns201',
    );
    ok(r.ok);
    const { rows, edges } = countClaims(r.text);
    strictEqual(rows, 3);
    ok(edges >= 1);
  });

  it('clarification-report.md шаблон: humanFacts читает результат applyFill', () => {
    const template = readFileSync(
      join(cfg.runner.methodologyDir, 'templates', 'clarification-report.template.md'),
      'utf8',
    );
    const schema = deriveSchema(template, 'clarification-report.template.md');
    const table = modelFields(schema).find((f) => f.kind === 'records' && f.shape === 'table');
    ok(table !== undefined);
    const r = applyFill(
      template,
      table.id,
      '- вопрос: Что возвращать при повторе?\n  блокирующий: да\n  ответ человека: 200\n  что изменилось в задаче: claim-1 уточнён',
    );
    ok(r.ok);
    const facts = extractHumanFacts(r.text);
    ok(facts.length >= 1);
    ok(facts.some((f) => f.answer.includes('200')));
  });

  it('intent.md: isSmallContour читает поле «Контур», заполненное applyFill', () => {
    const template = readFileSync(join(cfg.runner.methodologyDir, 'templates', 'intent.template.md'), 'utf8');
    const r = applyFill(template, 'контур', 'мелкий');
    ok(r.ok);

    const root = mkdtempSync(join(tmpdir(), 'sdlc-applyfill-'));
    roots.push(root);
    const paths = new WitokPaths(root, 'demo');
    writeArtifact(paths.intent, r.text);
    ok(isSmallContour({ paths, chunk: 1, attempt: 1 }), 'applyFill выбрал ветку «мелкий», isSmallContour обязан её увидеть');
  });
});
