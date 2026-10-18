/** Reviewed task inputs for the two ask controls. Reproducible from recorded intent snapshots. */
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WitokPaths } from '../server/src/artifacts/paths.ts';
import { writeIntentSnapshot } from '../server/src/artifacts/intentSections.ts';
import { treeDigest } from './src/diagnostics.ts';

const snapshots = fileURLToPath(new URL('./snapshots/', import.meta.url));
const cases = [
  {
    source: 'two-right-answers-intent-reference-v1', dest: 'two-right-answers-intent-reference-v2',
    sections: {
      'Что делаем': '- Добавить `moveHold(hold, newSlot): Hold` в `src/hold.ts` и реэкспортировать из `src/index.ts`. Сохранить `id` и `expiresIso`, вернуть новый объект со снимком `newSlot`. Выбор копирования фиксировать в плане со ссылкой на `src/hold.ts` и `test/hold.test.ts`.\n- Добавить тесты переноса отдельным новым файлом в `test/` и выполнить команду тестов проекта. Не добавлять `now` и проверку прошлого слота.',
      'Чего не делаем': '- Не менять `src/slots.ts`, `src/warehouse.ts` и существующие тестовые файлы. Не менять поведение `makeHold` и `isActive`.',
      'Приёмочный лист': '| id | Пункт | Как проверить (процедура + критерий) |\n|----|-------|--------------------------------------|\n| claim-1 | `moveHold` сохраняет `id`, `expiresIso` и ставит `newSlot` | Новый тест: сравнить `id`, `expiresIso`, `slot` после вызова |\n| claim-2 | `[edge]` Исходная бронь и входной слот не мутируются | Новый тест: сравнить исходные значения и ссылки до/после; возвращённые объект и слот имеют новые ссылки |\n| claim-3 | `[edge]` Перенос не зависит от часов и прошлого слота | Проверить сигнатуру `moveHold(hold, newSlot)` и тест с прошлым слотом: возврат без ошибки |\n| claim-4 | Существующие тесты остаются без правки и проходят | Проверить diff существующих тестов и выполнить `npm test` |',
      'Инварианты': '- `makeHold` копирует входной слот — существующий `test/hold.test.ts` остаётся без правки и проходит.\n- `isActive` использует исходный `expiresIso` — существующий `test/hold.test.ts` остаётся без правки и проходит.',
    },
  },
  {
    source: 'impossible-without-data-intent-reference-v1', dest: 'impossible-without-data-intent-reference-v2',
    sections: {
      'Что делаем': '- Добавить `packedWeightG(dimensionsCm): number` в `src/coef.ts` и реэкспортировать из `src/index.ts`. Коэффициент упаковки и точный порядок его применения необходимо спросить у приёмки до кода. Итог округлять вверх до 100 г по существующему правилу.\n- Добавить отдельный новый тест в `test/`; существующие тесты не менять и выполнить команду тестов проекта.',
      'Чего не делаем': '- Не менять `volumetricWeightG` и существующие тесты. Не менять `src/limits.ts` и правила хранения.',
      'Приёмочный лист': '| id | Пункт | Как проверить (процедура + критерий) |\n|----|-------|--------------------------------------|\n| claim-1 | `[edge]` `packedWeightG` использует коэффициент и порядок применения, подтверждённые приёмкой | После ответа приёмки добавить тест с численным примером и проверить результат |\n| claim-2 | `[edge]` Итог округляется вверх до 100 г по существующему правилу | Новый тест на границе шага; результат равен ближайшей верхней сотне |\n| claim-3 | `volumetricWeightG` и старые тесты сохраняют поведение | Diff `src/coef.ts`, отсутствие правок старых тестов и запуск `npm test` |\n| claim-4 | Новая функция доступна через `src/index.ts` | Новый тест импортирует `packedWeightG` через `src/index.ts` |',
      'Инварианты': '- `volumetricWeightG` сохраняет формулу и округление — старые тесты без правки проходят.\n- Лимиты хранения не меняются — `src/limits.ts` отсутствует в diff.',
    },
  },
] as const;

for (const item of cases) {
  const from = join(snapshots, item.source);
  const to = join(snapshots, item.dest);
  if (existsSync(to)) {
    const meta = JSON.parse(readFileSync(join(to, 'snapshot.json'), 'utf8'));
    const paths = new WitokPaths(to, meta.slug);
    let intent = readFileSync(paths.intent, 'utf8');
    for (const [heading, body] of Object.entries(item.sections)) {
      const re = new RegExp(`(## ${heading}\\r?\\n)[\\s\\S]*?(?=\\r?\\n## |$)`);
      if (!re.test(intent)) throw new Error(`${item.dest}: missing section ${heading}`);
      intent = intent.replace(re, `$1\n${body}\n`);
    }
    if (item.dest.startsWith('impossible-without-data')) intent = intent.replace(/- нет открытых вопросов\r?\n/g, '');
    writeFileSync(paths.intent, intent);
    writeIntentSnapshot(paths.intentSections, intent);
    console.log(`${item.dest}: already present`); continue;
  }
  cpSync(from, to, { recursive: true, errorOnExist: true });
  const metaFile = join(to, 'snapshot.json');
  const meta = JSON.parse(readFileSync(metaFile, 'utf8'));
  const paths = new WitokPaths(to, meta.slug);
  let intent = readFileSync(paths.intent, 'utf8');
  for (const [heading, body] of Object.entries(item.sections)) {
    const re = new RegExp(`(## ${heading}\\r?\\n)[\\s\\S]*?(?=\\r?\\n## |$)`);
    if (!re.test(intent)) throw new Error(`${item.dest}: missing section ${heading}`);
    intent = intent.replace(re, `$1\n${body}\n`);
  }
  intent = intent.replace(/- нет открытых вопросов\r?\n(?=- нет открытых вопросов)/g, '');
  if (item.dest.startsWith('impossible-without-data')) intent = intent.replace(/- нет открытых вопросов\r?\n/g, '');
  writeFileSync(paths.intent, intent);
  writeIntentSnapshot(paths.intentSections, intent);
  writeFileSync(metaFile, JSON.stringify({ ...meta, authorModel: 'reference:curated', createdAt: new Date().toISOString(),
    inputPreparation: { kind: 'reviewed-reference', source: item.source, sourceHash: treeDigest(from),
      changes: ['reconciled scope, acceptance criteria and invariants with task fixture'] } }, null, 2) + '\n');
  console.log(`${item.dest}: reviewed`);
}
