/** Remove documented factual mistakes from the two recorded plan inputs. */
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WitokPaths } from '../server/src/artifacts/paths.ts';
import { writeIntentSnapshot } from '../server/src/artifacts/intentSections.ts';
import { checkDiagnosticInput, type DiagnosticCase } from './src/diagnosticInputs.ts';
import { treeDigest } from './src/diagnostics.ts';

const bench = fileURLToPath(new URL('./', import.meta.url));
const snapshots = join(bench, 'snapshots');

function replace(text: string, old: string | RegExp, next: string, name: string): string {
  if (!(typeof old === 'string' ? text.includes(old) : old.test(text))) throw new Error(`missing ${name}`);
  return text.replace(old, next);
}

function refine(id: 'P01' | 'P02', task: string, source: string, name: string,
  edit: (paths: WitokPaths) => string[]): void {
  const sourceRoot = join(snapshots, source);
  const dest = join(snapshots, name);
  const testCase: DiagnosticCase = { id, task, stage: 'plan', snapshotAfter: 'ask', snapshot: name, evaluation: 'decision' };
  if (existsSync(dest)) {
    const status = checkDiagnosticInput(bench, testCase);
    if (status.status !== 'available') throw new Error(`${name}: ${status.reason}`);
    console.log(`${id}: ${name}, already present`);
    return;
  }
  cpSync(sourceRoot, dest, { recursive: true, errorOnExist: true });
  const metaFile = join(dest, 'snapshot.json');
  const meta = JSON.parse(readFileSync(metaFile, 'utf8'));
  const changes = edit(new WitokPaths(dest, meta.slug));
  meta.createdAt = new Date().toISOString();
  meta.inputPreparation = { kind: 'reviewed-reference', source, sourceHash: treeDigest(sourceRoot),
    sourceAuthorModel: meta.inputPreparation?.sourceAuthorModel, changes };
  writeFileSync(metaFile, JSON.stringify(meta, null, 2) + '\n');
  const input = checkDiagnosticInput(bench, testCase);
  if (input.status !== 'available') throw new Error(`${name}: ${input.reason}`);
  console.log(`${id}: ${name}, reviewed`);
}

refine('P01', 'config-default', 'config-default-plan-reference-v1', 'config-default-plan-reference-v2', (p) => {
  let intent = readFileSync(p.intent, 'utf8');
  intent = replace(intent, '- `Invoice` получает поле `dueDays: number` с приоритетом: явная опция → конфиг → 14',
    '- `Invoice` получает обязательное поле `dueDays: number`; `bill(number, customer, lines, config?, opts?)` принимает `opts.dueDays?: number` пятым параметром с приоритетом: opts → конфиг → 14', 'fifth argument');
  intent = replace(intent, '- Ветка `sdlc/config-default` используется как рабочее дерево, поле `что делаем` обновлено\r\n', '', 'spurious scope item');
  intent = replace(intent, /\| claim-1 \|[^\r\n]*\r?\n\| claim-2 \|[^\r\n]*\r?\n\| claim-3 \|[^\r\n]*\r?\n\| claim-4 \|[^\r\n]*/,
    '| claim-1 | `[edge]` Вызов `bill` без opts и конфига даёт `dueDays: 14` | Добавить проверку в `test/invoice.test.ts`; `npm test` проходит, поле равно 14 |\n' +
    '| claim-2 | Явный `opts.dueDays` побеждает конфиг площадки | Добавить проверку с разными значениями opts и config; `npm test` проходит, поле равно opts.dueDays |\n' +
    '| claim-3 | `[edge]` Конфиг площадки побеждает встроенный дефолт при отсутствии opts | Добавить проверку с `config.defaultDueDays`; `npm test` проходит, поле равно значению конфига |\n' +
    '| claim-4 | Все счета имеют шесть полей и `defaultDueDays` описан в README | Обновить существующий тест формы счёта в `test/invoice.test.ts` на шесть полей; `npm test` проходит; сверить строку в разделе «Конфигурация» README |', 'duplicate and invented test claims');
  intent = replace(intent, '- `defaultDueDays` — конфиг, не задокументированный рядом с типом, находят по второму разу. / н/п — проектных условий нет',
    '- н/п — дополнительных проектных условий остановки нет', 'stop condition');
  writeFileSync(p.intent, intent);
  writeIntentSnapshot(p.intentSections, intent);
  let explore = readFileSync(p.explorationReport, 'utf8');
  explore = replace(explore, /^\| src\/money\.ts \|[^\r\n]*\r?\n/m, '', 'unmodified money row');
  explore = replace(explore, '| src/index.ts | bill | обновить для нового поведения |',
    '| src/index.ts | bill | передать пятый аргумент opts в buildInvoice |\n| README.md | таблица опций в разделе «Конфигурация» | описать defaultDueDays |', 'missing README row');
  explore = replace(explore, '| BillingConfig | src/config.ts:BillingConfig | добавляет поле `dueDays` в `Invoice` с приоритетом значений из опций, конфига и дефолта 14 | используем `BillingConfig` для хранения `defaultDueDays` и объявляем `resolveConfig` для слияния конфига и опций |',
    '| BillingConfig | src/config.ts:BillingConfig | описывает конфиг площадки | добавляем `defaultDueDays`; `resolveConfig` уже сливает конфиг с дефолтами |', 'incorrect BillingConfig description');
  writeFileSync(p.explorationReport, explore);
  return ['specified fifth opts argument', 'replaced duplicate invented test claims', 'removed workflow item and false stop condition', 'corrected file map and BillingConfig description'];
});

refine('P02', 'migration-compat', 'migration-compat-plan-reference-v1', 'migration-compat-plan-reference-v2', (p) => {
  let intent = readFileSync(p.intent, 'utf8');
  intent = replace(intent, /- Не трогаем Не меняем/g, '- Не меняем', 'duplicated exclusion phrase');
  intent = replace(intent, 'построение объекта через конструктор с 1, 2, 3 и 4 параметрами',
    'вызов `product(code, title, priceK)` и вызов с четвёртым параметром', 'invalid constructor calls');
  intent = replace(intent, 'сверка значения vatRate с константой по умолчанию',
    'сверка `vatRate === 20` по подтверждённому ответу человека', 'explicit compatibility default');
  writeFileSync(p.intent, intent);
  writeIntentSnapshot(p.intentSections, intent);
  return ['removed repeated exclusion text', 'replaced impossible constructor calls', 'recorded human-approved 20 in acceptance'];
});

refine('P01', 'config-default', 'config-default-plan-reference-v2', 'config-default-plan-reference-v3', (p) => {
  let intent = readFileSync(p.intent, 'utf8');
  intent = replace(intent, '- src/index.ts — обновить для нового поведения\r\n',
    '- src/index.ts — передать opts пятым аргументом в buildInvoice\r\n- README.md — документировать defaultDueDays в разделе «Конфигурация»\r\n',
    'missing README in required files');
  intent = replace(intent, '- Тесты в `test/` обновлены для нового поведения, включая изменение теста `test/invoice.test.ts`',
    '- Добавить тесты нового поведения рядом с существующими; из существующих тестов менять только проверку формы счёта на шесть полей в `test/invoice.test.ts`',
    'existing test constraints');
  writeFileSync(p.intent, intent);
  writeIntentSnapshot(p.intentSections, intent);
  return ['added README to required files so plan scope checks its omission', 'preserved restriction on existing tests'];
});

refine('P02', 'migration-compat', 'migration-compat-plan-reference-v2', 'migration-compat-plan-reference-v3', (p) => {
  let intent = readFileSync(p.intent, 'utf8');
  intent = replace(intent, '- test/store.test.ts — обновить тесты для проверки vatRate в цикле round-trip\r\n',
    '', 'forbidden test edit in required files');
  intent = replace(intent, '- Не меняем структуру и формат JSONL строк при сериализации',
    '- Сохраняем JSONL: одна запись на строку; имена и порядок существующих полей не меняем, `vatRate` добавляем после `priceK`',
    'contradictory JSONL restriction');
  intent = replace(intent, '- Не трогаем Не изменяем логику при работе с существующими тестами\r\n',
    '', 'duplicated test exclusion');
  intent = replace(intent, '- Обеспечить идентичность значения по умолчанию для конструктора Product и для поля в формате данных.',
    '- Использовать одну константу со значением 20 для `product()` без четвёртого аргумента и для `parse()` старой записи без `vatRate`.',
    'human-approved default');
  intent = replace(intent, '- н/п — проектных инвариантов нет, действуют только общие\r\n',
    '', 'contradictory invariant fallback');
  intent = replace(intent, /- README не трогаем \/ н\/п — проектных условий нет\r?\n- каталог test\/ не трогаем \/ н\/п — проектных условий нет\r?\n- Артикул, название и цена не меняются \/ н\/п — проектных условий нет\r?\n- формат файла \(JSONL, строка на запись\) не меняется \/ н\/п — проектных условий нет/,
    '- н/п — дополнительных проектных условий остановки нет', 'repeated stop conditions');
  writeFileSync(p.intent, intent);
  writeIntentSnapshot(p.intentSections, intent);
  return ['removed forbidden test edit', 'clarified JSONL framing and appended field', 'recorded common approved default 20', 'removed contradictory fallback and repeated stop conditions'];
});

refine('P01', 'config-default', 'config-default-plan-reference-v3', 'config-default-plan-reference-v4', (p) => {
  let explore = readFileSync(p.explorationReport, 'utf8');
  explore = replace(explore, '**Решение человека о полноте:** Бенчмарк · 2026-09-30',
    '**Решение человека о полноте:** не запрашивалось; независимый список остаётся кандидатом для проверки в плане',
    'unsupported completeness approval');
  writeFileSync(p.explorationReport, explore);
  return ['removed unsupported claim that the benchmark approved the independent acceptance list'];
});

refine('P02', 'migration-compat', 'migration-compat-plan-reference-v3', 'migration-compat-plan-reference-v4', (p) => {
  let explore = readFileSync(p.explorationReport, 'utf8');
  explore = replace(explore, /^\| test\/store\.test\.ts \|[^\r\n]*\r?\n/m, '', 'test file in edit map');
  explore = replace(explore, '**Решение человека о полноте:** Бенчмарк · 2026-09-30',
    '**Решение человека о полноте:** не запрашивалось; подтверждён только ответ о ставке 20 в clarification-report.md',
    'unsupported completeness approval');
  writeFileSync(p.explorationReport, explore);
  return ['removed prohibited test file from edit map', 'limited recorded human decision to the actual answer about 20'];
});
