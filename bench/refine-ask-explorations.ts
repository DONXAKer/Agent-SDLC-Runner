/** Remove demonstrably false exploration claims before pinning ask inputs. */
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WitokPaths } from '../server/src/artifacts/paths.ts';
import { writeIntentSnapshot } from '../server/src/artifacts/intentSections.ts';
import { treeDigest } from './src/diagnostics.ts';

const snapshots = fileURLToPath(new URL('./snapshots/', import.meta.url));
const definitions = [
  { source: 'impossible-without-data-explore-reference-v4', dest: 'impossible-without-data-explore-reviewed-v1',
    slug: 'matrix-a02-explore-v4',
    map: '| src/coef.ts | `DimensionsCm`, `volumetricWeightG`, `WEIGHT_STEP_G`; коэффициент упаковки отсутствует | добавить `packedWeightG` после решения приёмки, сохранив существующий расчёт |\n| src/index.ts | реэкспортирует функции из `coef.ts` | реэкспортировать `packedWeightG` |\n| test/packed-weight.test.ts | файла нет — новый | добавить отдельные тесты нового правила после решения приёмки |',
    reuse: '| DimensionsCm | src/coef.ts:DimensionsCm | тип трёх габаритов в сантиметрах | использовать как тип аргумента новой функции |\n| WEIGHT_STEP_G | src/coef.ts:WEIGHT_STEP_G | шаг округления 100 г внутри `coef.ts` | использовать для округления итога после уточнения порядка применения коэффициента |',
    touch: '- src/coef.ts — добавить `packedWeightG` после ответа приёмки; `volumetricWeightG` сохранить\n- src/index.ts — реэкспортировать новую функцию\n- test/packed-weight.test.ts — новый тестовый файл; существующие тесты не менять',
  },
  { source: 'two-right-answers-explore-reference-v3', dest: 'two-right-answers-explore-reviewed-v1',
    slug: 'matrix-a01-explore-v3',
    map: '| src/hold.ts | `Hold`, `makeHold`, `isActive`; `makeHold` создаёт новый объект и копирует слот | добавить `moveHold`, возвращающий новый объект и копию `newSlot`, сохранив `id` и `expiresIso` |\n| src/index.ts | реэкспортирует API брони | реэкспортировать `moveHold` |\n| test/move-hold.test.ts | файла нет — новый | добавить отдельные тесты переноса и иммутабельности |',
    reuse: '| Hold | src/hold.ts:Hold | тип брони с `id`, снимком `slot` и `expiresIso` | тип аргумента и результата `moveHold` |\n| Slot | src/slots.ts:Slot | тип слота | тип нового слота без изменения `src/slots.ts` |',
    touch: '- src/hold.ts — добавить `moveHold` с новым объектом и снимком слота\n- src/index.ts — реэкспортировать `moveHold`\n- test/move-hold.test.ts — новый тестовый файл; существующие тесты не менять',
  },
] as const;

function section(text: string, heading: string, body: string): string {
  const re = new RegExp(`(## ${heading}\\r?\\n)[\\s\\S]*?(?=\\r?\\n## |$)`);
  if (!re.test(text)) throw new Error(`missing ${heading}`);
  return text.replace(re, `$1\n${body}\n`);
}

for (const item of definitions) {
  const from = join(snapshots, item.source), to = join(snapshots, item.dest);
  if (!existsSync(from)) { console.log(`${item.dest}: source pending`); continue; }
  if (existsSync(to)) {
    const meta = JSON.parse(readFileSync(join(to, 'snapshot.json'), 'utf8'));
    const paths = new WitokPaths(to, meta.slug);
    let report = readFileSync(paths.explorationReport, 'utf8').replace(/\| (test\/(?:move-hold|packed-weight)\.test\.ts) \| файла нет \|/g, '| $1 | файла нет — новый |');
    report = section(report, 'Риски', item.source.startsWith('two-right')
      ? '- `moveHold` не должен менять объект `hold` или хранить ссылку на `newSlot`; это проверяется новым тестом.'
      : '- Коэффициент нельзя применять после уже округлённого `volumetricWeightG`: это даст иной результат у границы 100 г; порядок подтверждает приёмка.');
    writeFileSync(paths.explorationReport, report);
    console.log(`${item.dest}: already present`); continue;
  }
  cpSync(from, to, { recursive: true, errorOnExist: true });
  const metaFile = join(to, 'snapshot.json');
  const meta = JSON.parse(readFileSync(metaFile, 'utf8'));
  const paths = new WitokPaths(to, meta.slug);
  let report = readFileSync(paths.explorationReport, 'utf8');
  report = section(report, 'Карта кодовой базы', '| Файл | Что там сейчас | Что меняем |\n|---|---|---|\n' + item.map);
  report = section(report, 'Найдено для переиспользования', '| Символ | Где (`путь:символ`) | Что делает | Как используем |\n|---|---|---|---|\n' + item.reuse);
  if (item.source.startsWith('impossible')) {
    report = report.replace(/^- src\/coef\.ts — `packedWeightG`[^\r\n]*$/m,
      '- src/coef.ts — коэффициент упаковки и порядок его применения отсутствуют в коде; `FRAGILITY_FACTOR` относится к хрупкости и не заменяет ответ приёмки');
  }
  if (item.source.startsWith('two-right')) {
    report = section(report, 'Всплывшие вопросы', '- нет вопросов: выбор копирования подтверждён `src/hold.ts` и `test/hold.test.ts`; записать его в плане до кода.');
  }
  report = section(report, 'Риски', item.source.startsWith('two-right')
    ? '- `moveHold` не должен менять объект `hold` или хранить ссылку на `newSlot`; это проверяется новым тестом.'
    : '- Коэффициент нельзя применять после уже округлённого `volumetricWeightG`: это даст иной результат у границы 100 г; порядок подтверждает приёмка.');
  writeFileSync(paths.explorationReport, report);
  const intent = section(readFileSync(paths.intent, 'utf8'), 'Что придётся тронуть', item.touch);
  writeFileSync(paths.intent, intent);
  writeIntentSnapshot(paths.intentSections, intent);
  writeFileSync(metaFile, JSON.stringify({ ...meta, authorModel: 'reference:curated', createdAt: new Date().toISOString(),
    inputPreparation: { kind: 'reviewed-reference', source: item.source, sourceAuthorModel: meta.authorModel,
      sourceHash: treeDigest(from), changes: ['corrected file map against source code',
        'removed unsupported reuse claims', 'kept required human decision open or code-based choice resolved'] } }, null, 2) + '\n');
  console.log(`${item.dest}: reviewed`);
}
