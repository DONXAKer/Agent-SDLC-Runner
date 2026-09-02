/**
 * `deriveSchema`: вывод полей формы из текста бланка.
 *
 * Герметичные кейсы — по одному на каждое правило вывода (§1.2 плана). Прогон по реальным
 * шаблонам эталона пропускается с названной причиной, если его нет на машине, — конвенция
 * репозитория (`server/test/prompt.test.ts`).
 */

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { loadConfig } from '../src/config/load.ts';
import {
  SCHEMA_OVERRIDES,
  deriveSchema,
  findField,
  menuOptionsOfPlaceholder,
  modelFields,
} from '../src/artifacts/formSchema.ts';

function нетЭталона(dir: string): string | false {
  return existsSync(dir) ? false : `нет эталона методологии на этой машине: ${dir}`;
}

describe('menuOptionsOfPlaceholder', () => {
  it('глифы — перечисление', () => {
    const o = menuOptionsOfPlaceholder('✅/❌/⏭');
    ok(o !== null);
    deepStrictEqual(
      o.map((x) => x.key),
      ['✅', '❌', '⏭'],
    );
  });

  it('словарные токены — перечисление', () => {
    const o = menuOptionsOfPlaceholder('да / шага не было');
    ok(o !== null);
    deepStrictEqual(
      o.map((x) => x.key),
      ['да', 'шага не было'],
    );
  });

  it('произвольная подсказка через "/" — не перечисление', () => {
    strictEqual(menuOptionsOfPlaceholder('тест / место в коде'), null);
    strictEqual(menuOptionsOfPlaceholder('sdlc/слаг или по конвенции проекта'), null);
  });
});

describe('deriveSchema: строка-метка', () => {
  it('поле с меткой и одним плейсхолдером — scalar', () => {
    const s = deriveSchema('# Задача\n\n- **Ветка витка:** ‹sdlc/слаг›\n');
    const f = findField(s, 'ветка витка');
    ok(f !== undefined);
    strictEqual(f.kind, 'scalar');
    strictEqual(f.shape, 'label');
    strictEqual(f.owner, 'model');
  });

  it('меню без плейсхолдера — choice (Контур)', () => {
    const s = deriveSchema('# Задача\n\n- **Контур:** полный / мелкий — критерий в SDLC.md\n');
    const f = findField(s, 'контур');
    ok(f !== undefined);
    strictEqual(f.kind, 'choice');
    deepStrictEqual(f.options?.map((o) => o.key).sort(), ['мелкий', 'полный']);
  });

  it('меню в прозе, где перед ним живёт своё двоеточие, не путается с меткой', () => {
    // «Карта разведки» — нейтральное поле того же вида строки, что и решение «Одобрение»
    // (проверено отдельно ниже): значение содержит двоеточие ДО настоящего меню
    // («совпала / разошлась» после «Карта разведки:» — в этом кейсе двоеточия внутри
    // значения нет, а вот у «Сверка с деревом» оно есть — покрыто прогоном по эталону).
    const s = deriveSchema(
      '# Журнал\n\n- Карта разведки: совпала / разошлась — ‹что именно; расхождение = возврат на план›\n',
    );
    const f = findField(s, 'карта разведки');
    ok(f !== undefined);
    strictEqual(f.kind, 'choice');
    strictEqual(f.options?.length, 2);
    const withComment = f.options?.find((o) => o.commentSlot);
    ok(withComment !== undefined, 'вторая ветка несёт слот комментария');
  });

  it('поле "Одобрение" — решение человека, а не choice', () => {
    const s = deriveSchema(
      '# План\n\n- **Одобрение:** ‹имя› · ‹дата› / **не одобрен — этап 5 не начинается**\n',
    );
    strictEqual(modelFields(s).length, 0);
  });

  it('несколько плейсхолдеров в строке-метке — подполя', () => {
    const s = deriveSchema(
      '# Отчёт\n\n- **Вход:** отчёт разведки ‹да/нет› · отчёт по вопросам ‹да / шага не было›\n',
    );
    const sub1 = findField(s, 'вход/1');
    const sub2 = findField(s, 'вход/2');
    ok(sub1 !== undefined && sub2 !== undefined);
    strictEqual(sub1.kind, 'choice');
    strictEqual(sub2.kind, 'choice');
  });
});

describe('deriveSchema: таблицы', () => {
  it('строка-образец с плейсхолдерами → records, min для листа приёмки', () => {
    const text = [
      '## Приёмочный лист',
      '',
      '| id | Пункт | Как проверить (процедура + критерий) |',
      '|----|-------|--------------------------------------|',
      '| claim-1 | ‹наблюдаемое поведение› | ‹процедура и критерий годности› |',
      '',
    ].join('\n');
    const s = deriveSchema(text);
    const f = findField(s, 'приемочный лист');
    ok(f !== undefined);
    strictEqual(f.kind, 'records');
    strictEqual(f.columns?.length, 3);
    strictEqual(f.columns?.[0]?.kind, 'mechanical');
    ok(f.min !== undefined);
  });

  it('фиксированная строка (нет плейсхолдеров-образца) → поле на ячейку', () => {
    const text = [
      '| Гейт | Вкл | Где отчитывается | Чем реализован |',
      '|---|---|---|---|',
      '| Сборка | да — минимум | этап 6 | ‹команда› |',
      '',
    ].join('\n');
    const s = deriveSchema(text);
    const f = s.fields.find((x) => x.shape === 'cell');
    ok(f !== undefined);
    strictEqual(f.kind, 'scalar');
  });

  it('строка без плейсхолдеров сразу за образцом — emptyAlternative на records-поле', () => {
    const text = [
      '| Путь | Что делаем |',
      '|---|---|',
      '| ‹path/to/file› | ‹что делаем› |',
      '| нет изменений | н/п |',
      '',
    ].join('\n');
    const s = deriveSchema(text);
    const f = s.fields.find((x) => x.kind === 'records');
    ok(f !== undefined);
    strictEqual(f.emptyAlternative, '| нет изменений | н/п |');
  });

  it('колонка "Утвердил"/"Кто" — вся строка решение, не отдаётся модели', () => {
    const text = [
      '| Гейт | Почему бессмыслен | Утвердил (человек) |',
      '|---|---|---|',
      '| ‹гейт› | ‹причина› | ‹имя› |',
      '',
    ].join('\n');
    const s = deriveSchema(text);
    strictEqual(modelFields(s).length, 0);
    ok(s.fields.some((f) => f.kind === 'decision'));
  });
});

describe('deriveSchema: списки', () => {
  it('- ‹x› — list', () => {
    const s = deriveSchema('## Что делаем\n\n- ‹что делаем›\n');
    const f = s.fields.find((x) => x.shape === 'bullets');
    ok(f !== undefined);
    strictEqual(f.kind, 'list');
  });

  it('- ‹a› — ‹b› — records с ключами из текста плейсхолдеров', () => {
    const s = deriveSchema('## Что придётся тронуть\n\n- ‹path/to/file› — ‹что здесь меняем›\n');
    const f = s.fields.find((x) => x.shape === 'bullets');
    ok(f !== undefined);
    strictEqual(f.kind, 'records');
    strictEqual(f.columns?.length, 2);
  });

  it('- ‹x› / н/п — причина — emptyAlternative', () => {
    const s = deriveSchema('## Необратимые шаги\n\n- ‹необратимый шаг› — подтверждает человек / н/п\n');
    const f = s.fields.find((x) => x.shape === 'bullets');
    ok(f !== undefined);
    ok(f.emptyAlternative !== undefined);
  });

  it('нумерованный список — list', () => {
    const s = deriveSchema('## Шаги\n\n1. ‹шаг›\n2. ‹шаг›\n');
    const f = s.fields.find((x) => x.shape === 'bullets');
    ok(f !== undefined);
    strictEqual(f.kind, 'list');
  });
});

describe('deriveSchema: абзац и yaml', () => {
  it('одиночный плейсхолдер строкой — multiline', () => {
    const s = deriveSchema('## Коротко\n\n‹что делаем›\n');
    const f = s.fields.find((x) => x.shape === 'paragraph');
    ok(f !== undefined);
    strictEqual(f.kind, 'multiline');
  });

  it('yaml-блок — поле на ключ, singleLine', () => {
    const text = ['## Состояние', '', '```yaml', 'slug: ‹slug›', 'branch: ‹sdlc/слаг›', '```', ''].join(
      '\n',
    );
    const s = deriveSchema(text);
    const f = s.fields.find((x) => x.shape === 'yaml' && x.label === 'slug');
    ok(f !== undefined);
    ok(f.singleLine);
  });
});

describe('deriveSchema: решения человека не отдаются модели', () => {
  it('строка "Подтвердил" — decision', () => {
    const text = '- **Подтвердил:** ‹имя› · ‹дата› / использовано одобрение плана через ExitPlanMode этой сессии\n';
    const s = deriveSchema(text);
    strictEqual(modelFields(s).length, 0);
  });

  it('перенос поля решения на вторую строку — тоже decision (урок ревью)', () => {
    const text =
      '- **Подтвердил:** ‹имя› · ‹дата› / использовано одобрение плана через ExitPlanMode этой сессии —\n' +
      '  сказано человеку явно\n';
    const s = deriveSchema(text);
    strictEqual(modelFields(s).length, 0);
  });
});

describe('deriveSchema: группа (handoff "### Запись N")', () => {
  it('заголовок записи даёт поле-group', () => {
    const s = deriveSchema('### Запись 1\n\n- **Имя:** ‹три-четыре слова›\n');
    const g = s.fields.find((f) => f.kind === 'group');
    ok(g !== undefined);
    const name = s.fields.find((f) => f.label === 'имя');
    ok(name !== undefined);
    ok(name.section.includes('запись 1'));
  });
});

describe('deriveSchema: цитаты и инлайн-код не дают полей', () => {
  it('плейсхолдер внутри `‹…›` в бэктиках не считается', () => {
    const s = deriveSchema('Пример: `‹…›` — незаполненное место.\n');
    strictEqual(s.fields.length, 0);
  });

  it('плейсхолдер в markdown-цитате не считается', () => {
    const s = deriveSchema('> Незаполненные места помечены `‹…›`.\n');
    strictEqual(s.fields.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Прогон по реальным шаблонам эталона
// ---------------------------------------------------------------------------

const cfg = loadConfig();
const templatesDir = join(cfg.runner.methodologyDir, 'templates');

describe('deriveSchema: реальные шаблоны эталона', { skip: нетЭталона(templatesDir) }, () => {
  const files = readdirSync(templatesDir).filter((f) => f.endsWith('.template.md'));

  it('каждый ключ SCHEMA_OVERRIDES находит поле в своём шаблоне', () => {
    const problems: string[] = [];
    for (const name of files) {
      const table = SCHEMA_OVERRIDES[name];
      if (table === undefined) continue;
      const text = readFileSync(join(templatesDir, name), 'utf8');
      const schema = deriveSchema(text, name);
      if (schema.unresolvedOverrides.length > 0) {
        problems.push(`${name}: не нашлись ключи ${schema.unresolvedOverrides.join(', ')}`);
      }
    }
    deepStrictEqual(problems, [], problems.join('\n'));
  });

  it('каждый шаблон разбирается без исключений и даёт хотя бы одно поле', () => {
    for (const name of files) {
      const text = readFileSync(join(templatesDir, name), 'utf8');
      const schema = deriveSchema(text, name);
      ok(schema.fields.length > 0, `${name}: полей не найдено`);
    }
  });

  it('план: пункты приёмки — records с минимумом, колонка id — mechanical', () => {
    const text = readFileSync(join(templatesDir, 'intent.template.md'), 'utf8');
    const schema = deriveSchema(text, 'intent.template.md');
    const f = findField(schema, 'приемочный лист');
    ok(f !== undefined);
    strictEqual(f.kind, 'records');
    ok(f.min !== undefined);
    strictEqual(f.columns?.[0]?.kind, 'mechanical');
  });

  it('gates: колонка "Кто" в таблице долга — decision, не модели', () => {
    const text = readFileSync(join(templatesDir, 'gates.template.md'), 'utf8');
    const schema = deriveSchema(text, 'gates.template.md');
    const decisionRows = schema.fields.filter((f) => f.kind === 'decision');
    ok(decisionRows.length > 0);
  });

  it('handoff: yaml-блок вида "### Запись N" даёт группу и подполя', () => {
    const text = readFileSync(join(templatesDir, 'handoff.template.md'), 'utf8');
    const schema = deriveSchema(text, 'handoff.template.md');
    ok(schema.fields.some((f) => f.kind === 'group'));
    ok(schema.fields.some((f) => f.shape === 'yaml'));
  });

  it('readiness: таблицы прогонов — фиксированные строки с полем на ячейку', () => {
    const text = readFileSync(join(templatesDir, 'readiness.template.md'), 'utf8');
    const schema = deriveSchema(text, 'readiness.template.md');
    ok(schema.fields.some((f) => f.shape === 'cell'));
  });
});
