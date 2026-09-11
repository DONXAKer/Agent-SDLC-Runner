/**
 * Этап 2 конвейером рантайма (`ExploreExecutor`).
 *
 * Модель подставная — проверяется рантайм: все записи идут через `hooks.onToolRequest`
 * (отказ гейта оставляет диск нетронутым); путь не из индекса без пометки «новый» в карту
 * не попадает, `+ путь` даёт строку «файла нет — новый»; вопросы рендерятся `- [ ]` и видны
 * этапу 3; плейсхолдер решения человека цел; «Что придётся тронуть» в задаче заполнено из
 * карты; без гейта осей — `н/п`; без слепого листа — `н/п`; страж фактичности карты доволен.
 *
 * Бланк — копия структуры эталонного `exploration-report.template.md`; второй набор кейсов
 * идёт по РЕАЛЬНОМУ шаблону из `SDLC_METHODOLOGY_DIR` и пропускается без него.
 */

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import type { NormalizedCall, ToolName } from '@sdlc-runner/shared';

import { countPlaceholdersExceptDecisions, decisionLabelsIn } from '../src/artifacts/artifact.ts';
import { WitokPaths } from '../src/artifacts/paths.ts';
import { ExploreExecutor, parseNumberedAnswer, parsePlusLines } from '../src/exec/ExploreExecutor.ts';
import type { ExecHooks, ExecRequest } from '../src/exec/StageExecutor.ts';
import { intentKeywords } from '../src/explore/keywords.ts';
import { readTree } from '../src/explore/tree.ts';
import { buildView } from '../src/explore/view.ts';
import type { ChatProvider, ChatRequest } from '../src/provider/ChatProvider.ts';
import { explorationPathProblem, hasOpenQuestions } from '../src/run/stages.ts';

const FIXTURE = join(import.meta.dirname, '..', '..', 'bench', 'fixture');
const METHODOLOGY = process.env['SDLC_METHODOLOGY_DIR'];

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const INTENT = [
  '# Задача: Бесплатная доставка',
  '',
  '- **Контур:** полный',
  '- **Ветка витка:** sdlc/freeship',
  '',
  '## Коротко',
  '_легенда_',
  '',
  'Для `gold` в ступени 3 `priceFor` (`src/tariffs.ts`) считает доставку бесплатной. Льгота отдельным модулем.',
  '',
  '## Что делаем',
  '',
  '- правило льготы отдельным модулем в `src/`, интеграция через `priceFor`',
  '',
  '## Чего не делаем',
  '',
  '- не меняем порядок применения скидки лояльности (`discountFor`)',
  '',
  '## Приёмочный лист',
  '',
  '| id | Пункт | Как проверить (процедура + критерий) |',
  '|----|-------|--------------------------------------|',
  '| claim-1 | для gold в ступени 3 total равен 0 | тест |',
  '| claim-2 [edge] | ступень 4 льготы не получает | тест |',
  '| claim-3 [edge] | silver и none без изменений | тест |',
  '',
  '## Что придётся тронуть',
  '_Заполняет агент на разведке._',
  '',
  '- ‹path/to/file› — ‹что здесь меняем›',
  '',
  '## Открытые вопросы',
  '',
  '- нет открытых вопросов',
  '',
].join('\n');

/** Структурная копия эталонного бланка отчёта разведки (легенды сокращены). */
const BLANK = [
  '# Отчёт разведки: ‹название витка›',
  '',
  '> Этап 2. Заполняет агент, проверяет человек **до** плана.',
  '',
  '- **Задача:** `intent.md` (‹название витка›) — ‹одно предложение о цели›',
  '- **Гейт «Заполненность артефактов»:** ‹✅/❌ — греп `‹…›` по артефактам этапов 1–2 и обязательные',
  '  секции› / ⏭ — гейт в долге',
  '',
  '## Стек и конвенции',
  '',
  '_Адреса кода везде в форме `файл:метод`._',
  '',
  '- Язык / стек: ‹что›',
  '- Сборка / тесты: ‹команды›',
  '- Конвенции: ‹что важно соблюдать›',
  '- Требования к окружению прогона: ‹что должно быть доступно, чтобы тесты этапа 6 запустились —',
  '  Docker, база, сеть; проверено ли это здесь› / ничего особенного',
  '',
  '## Карта кодовой базы',
  '_Только файлы, относящиеся к задаче._',
  '',
  '| Файл | Что там сейчас | Что меняем |',
  '|---|---|---|',
  '| ‹path/to/File› | ‹классы/методы› | ‹что добавить или изменить› |',
  '',
  '## Найдено для переиспользования',
  '_Самый ценный выход шага._',
  '',
  '| Символ | Где (`путь:символ`) | Что делает | Как используем |',
  '|---|---|---|---|',
  '| ‹Name› | ‹path/to/file:Name› | ‹что делает› | ‹как используем› |',
  '',
  '_Ничего подходящего не найдено: ‹да / нет — если да, таблицу выше удалить целиком›_',
  '',
  '## Опоры осей',
  '_Только если в наборе включён гейт «Разбор последствий»._',
  '',
  '| Ось | Механизм проекта (`путь:символ`) | Как он применяется здесь |',
  '|---|---|---|',
  '| ‹имя оси из канона› | ‹path/to/file:Symbol› / нет механизма | ‹как применяется / почему не применим› |',
  '',
  '## Приёмочный лист, выведенный независимо',
  '_Заполняет **отдельный агент**._',
  '',
  '| # | Выведенное утверждение | Есть у автора |',
  '|---|---|---|',
  '| 1 | ‹утверждение› | да / **нет — кандидат в пропуск** / вне scope — противоречит «‹строка из „Чего не делаем“›» |',
  '',
  '**Расхождение:** ‹что есть у автора и нет здесь; что здесь и нет у автора› / списки совпали /',
  'н/п — второго измерения не было',
  '',
  '**Решение человека о полноте:** ‹лист полон / пропуск найден: что именно› — ‹имя›',
  '',
  '## Точка правки',
  '_Конкретное место и почему именно сюда._',
  '',
  '- ‹путь/до/файла:метод› — ‹почему сюда›',
  '',
  '## Границы разведки',
  '_Что осознанно не разбирали._',
  '',
  '- ‹что не разбирали› — ‹почему допустимо› / границ нет — разобрано всё названное',
  '',
  '## Риски',
  '_Риск, уже записанный вопросом в задаче, здесь не повторяется._',
  '',
  '- ‹риск› / нет',
  '',
  '## Всплывшие вопросы',
  '_Что требует решения до chunk\'а._',
  '',
  '- [ ] **[блокирующий]** ‹вопрос›',
  '- нет вопросов',
  '',
].join('\n');

const MAP = '1. да | тарифная таблица и priceFor | добавить вызов правила льготы\n2. нет\n3. да | тесты расчёта | добавить кейс льготы\n+ src/freeship.ts | правило льготы: gold и ступень 3\n';
const REUSE = '1. да | считает итог | вызываем после льготы\n2. да | номер ступени | проверяем ступень 3\n3. нет\n';
const AXES = [
  '1. нет механизма | входные данные доверенные',
  '2. src/tariffs.ts:weightStep | ступени считаются один раз',
  '3. нет механизма | внешних зависимостей нет',
  '4. нет механизма | настроек нет',
  '5. src/discounts.ts:Tier | уровень клиента — часть типа',
  '6. нет механизма | логов нет',
].join('\n');
const QUESTIONS = '1. блокирующий | Распространяется ли льгота на silver?\n';

function provider(seen: ChatRequest[], answers: Partial<Record<'map' | 'reuse' | 'axes' | 'questions', string>> = {}): ChatProvider {
  return {
    name: 'stub',
    async chat(req: ChatRequest) {
      seen.push(req);
      const user = req.messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';
      let text = 'н/п';
      if (user.includes('## Сейчас — карта кодовой базы')) text = answers.map ?? MAP;
      else if (user.includes('## Сейчас — найдено для переиспользования')) text = answers.reuse ?? REUSE;
      else if (user.includes('## Сейчас — опоры осей')) text = answers.axes ?? AXES;
      else if (user.includes('## Сейчас — всплывшие вопросы')) text = answers.questions ?? QUESTIONS;
      else if (user.includes('- id: `конвенции`')) text = 'деньги в копейках целым числом';
      else if (user.includes('- id: `требования к окружению прогона`')) text = 'ничего особенного';
      else if (user.includes('- id: `точка правки`')) text = '- src/tariffs.ts:priceFor — здесь собирается итог';
      else if (user.includes('- id: `границы разведки`')) text = '- scripts/build-check.mjs — скрипт стенда, не про задачу';
      else if (user.includes('- id: `риски`')) text = '- порог silver нигде не записан';
      return {
        text,
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, durationMs: 1 },
        finishReason: 'end_turn' as const,
      };
    },
  } as unknown as ChatProvider;
}

function hooks(seen: { calls: NormalizedCall[]; warns: string[] }, allow = true): ExecHooks {
  return {
    onText: () => {},
    onThinking: () => {},
    onToolRequest: async (call: NormalizedCall) => {
      seen.calls.push(call);
      return allow ? { allowed: true, updatedInput: null, by: 'policy' as const } : { allowed: false, reason: 'отказ теста', by: 'policy' as const };
    },
    onToolResult: () => {},
    onAskHuman: async () => ({}),
    onRecord: () => '',
    onUsage: () => {},
    onWarn: (m: string) => seen.warns.push(m),
    onFriction: () => {},
  } as unknown as ExecHooks;
}

function setup(blank: string): { root: string; paths: WitokPaths } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sdlc-explore-exec-')));
  roots.push(root);
  for (const d of ['src', 'test', 'scripts']) cpSync(join(FIXTURE, d), join(root, d), { recursive: true });
  cpSync(join(FIXTURE, 'README.md'), join(root, 'README.md'));
  mkdirSync(join(root, '.sdlc', 'demo'), { recursive: true });
  const paths = new WitokPaths(root, 'demo');
  writeFileSync(paths.intent, INTENT);
  writeFileSync(paths.readiness, '# Готовность\n\n- **Дата:** 2026-01-01\n');
  writeFileSync(paths.explorationReport, blank);
  return { root, paths };
}

const eco = [{ dir: '.', label: 'Node.js', build: null, test: 'node --test' }];

function executor(
  root: string,
  paths: WitokPaths,
  over: { axesEnabled?: boolean; claims?: null; provider?: ChatProvider } = {},
): ExploreExecutor {
  const index = readTree(root);
  const kw = intentKeywords(INTENT);
  const axesEnabled = over.axesEnabled ?? false;
  const built = buildView(index, eco, kw, axesEnabled);
  return new ExploreExecutor({
    provider: over.provider ?? provider([]),
    maxResultBytes: 12_000,
    readRangeRequiredAboveBytes: 120_000,
    bashTimeoutMs: 1000,
    index,
    built,
    ecosystem: eco,
    intent: {
      path: paths.intent,
      readinessPath: paths.readiness,
      title: 'Бесплатная доставка',
      brief: 'Для gold в ступени 3 доставка бесплатна.',
      claims: [
        { id: 'claim-1', text: 'для gold в ступени 3 total равен 0' },
        { id: 'claim-2', text: 'ступень 4 льготы не получает' },
        { id: 'claim-3', text: 'silver и none без изменений' },
      ],
      notDoing: ['- не меняем порядок применения скидки лояльности (`discountFor`)'],
    },
    reportPath: paths.explorationReport,
    claims:
      over.claims === null
        ? null
        : { claims: [{ n: 1, text: 'для gold в ступени 3 total равен 0', check: 'тест', tags: [] }, { n: 2, text: 'порог silver задан явно', check: 'тест', tags: ['edge'] }], raw: '', envFailure: null, requestError: null },
    claimsSkipReason: null,
    axesEnabled,
    fillednessGate: 'enabled',
    edgeExample: [],
    cardBudgetBytes: 12_000,
  });
}

function request(root: string, paths: WitokPaths): ExecRequest {
  const ctx = { paths, chunk: 1, attempt: 1 };
  return {
    prompt: { presetNote: null, system: 'этап explore', user: 'входы', tools: [], editedByOperator: false },
    cwd: root,
    model: 'm',
    allowedTools: ['Read', 'Write', 'Edit'] as ToolName[],
    mcp: null,
    finishGuard: () => explorationPathProblem(ctx),
    salvageFromText: null,
    readOnlyDirs: [],
    subagents: [],
    maxTurns: 30,
    maxBudgetUsd: null,
    signal: new AbortController().signal,
  } as ExecRequest;
}

describe('разбор ответов', () => {
  it('нумерованные строки и строки будущих файлов', () => {
    deepStrictEqual(parseNumberedAnswer('1. да | a | b\nмусор\n2) нет\n2. дубль\n'), [
      { n: 1, parts: ['да', 'a', 'b'] },
      { n: 2, parts: ['нет'] },
    ]);
    deepStrictEqual(parsePlusLines('1. да\n+ `src/new.ts` | правило\n+ | пусто\n'), [{ path: 'src/new.ts', what: 'правило' }]);
  });

  it('+ строка без пути (проза вместо формы) не создаёт ложный «новый файл»', () => {
    deepStrictEqual(parsePlusLines('+ добавим обработку скидки | детали\n+ src/freeship.ts | правило\n'), [
      { path: 'src/freeship.ts', what: 'правило' },
    ]);
  });

  it('лишний «|» в последнем поле не теряется', () => {
    deepStrictEqual(parseNumberedAnswer('1. да | a | b | c\n'), [{ n: 1, parts: ['да', 'a', 'b', 'c'] }]);
  });
});

async function scenario(blank: string, over: { axesEnabled?: boolean; claims?: null } = {}) {
  const { root, paths } = setup(blank);
  const seen = { calls: [] as NormalizedCall[], warns: [] as string[] };
  const result = await executor(root, paths, over).run(request(root, paths), hooks(seen));
  return { root, paths, seen, result, report: readFileSync(paths.explorationReport, 'utf8'), intent: readFileSync(paths.intent, 'utf8') };
}

describe('конвейер разведки на копии бланка', () => {
  it('карта из индекса, новый файл помечен, вопросы видны этапу 3, записи только через гейт', async () => {
    const { seen, result, report, intent, paths } = await scenario(BLANK);
    ok(result.ok, result.note);
    ok(seen.calls.length >= 3, 'ожидались записи отчёта (×2) и задачи');
    ok(seen.calls.every((c) => c.kind === 'write'), 'не-Write вызов');
    ok(report.includes('| src/tariffs.ts | тарифная таблица и priceFor | добавить вызов правила льготы |'), report);
    ok(!report.includes('| src/discounts.ts |'), 'файл с ответом «нет» попал в карту');
    ok(report.includes('| src/freeship.ts | файла нет — новый | правило льготы: gold и ступень 3 |'));
    ok(report.includes('| priceFor | src/tariffs.ts:priceFor |'), 'переиспользование не записано');
    ok(report.includes('_Ничего подходящего не найдено: нет_'), report);
    ok(report.includes('- [ ] **[блокирующий]** Распространяется ли льгота на silver?'));
    ok(!report.includes('- нет вопросов'), 'альтернатива списка осталась');
    ok(hasOpenQuestions(report), 'этап 3 не увидит вопрос');
    ok(report.includes('н/п — гейт «Разбор последствий» в долге'), 'оси без гейта');
    ok(report.includes('| 1 | для gold в ступени 3 total равен 0 — тест | да (claim-1) |'), report);
    ok(report.includes('**нет — кандидат в пропуск**'));
    ok(report.includes('**Решение человека о полноте:** ‹лист полон'), 'решение человека затронуто');
    deepStrictEqual(decisionLabelsIn(report), decisionLabelsIn(BLANK));
    ok(report.includes('- **Гейт «Заполненность артефактов»:** ✅'), report);
    strictEqual(countPlaceholdersExceptDecisions(report), 0, report);
    ok(intent.includes('- src/tariffs.ts — добавить вызов правила льготы'), intent);
    ok(intent.includes('- src/freeship.ts — правило льготы: gold и ступень 3'));
    strictEqual(explorationPathProblem({ paths, chunk: 1, attempt: 1 }), null);
  });

  it('гейт осей включён: строки на все шесть осей, адрес не из индекса не сочиняется', async () => {
    const { report } = await scenario(BLANK, { axesEnabled: true });
    ok(report.includes('| Ресурсы и скорость | src/tariffs.ts:weightStep |'), report);
    ok(report.includes('| Совместимость и данные | src/discounts.ts:Tier |'));
    ok(report.includes('| Безопасность | нет механизма |'));
    ok(!report.includes('‹имя оси из канона›'));
  });

  it('без слепого листа таблица сверки — н/п', async () => {
    const { report } = await scenario(BLANK, { claims: null });
    ok(report.includes('н/п — второго измерения не было'), report);
    ok(!report.includes('| # | Выведенное утверждение'));
  });

  it('отказ гейта оставляет диск нетронутым и роняет этап', async () => {
    const { root, paths } = setup(BLANK);
    const seen = { calls: [] as NormalizedCall[], warns: [] as string[] };
    const result = await executor(root, paths).run(request(root, paths), hooks(seen, false));
    strictEqual(result.ok, false);
    strictEqual(readFileSync(paths.explorationReport, 'utf8'), BLANK);
    strictEqual(readFileSync(paths.intent, 'utf8'), INTENT);
  });

  it('повторный проход по уже заполненной карте и переиспользованию переписывает таблицы, а не молчит', async () => {
    const { root, paths } = setup(BLANK);
    const seen1 = { calls: [] as NormalizedCall[], warns: [] as string[] };
    const first = await executor(root, paths).run(request(root, paths), hooks(seen1));
    ok(first.ok, first.note);
    // Второй проход по УЖЕ заполненному отчёту (тот же файл на диске, без сброса к бланку —
    // так ведёт себя реальный повторный запуск этапа: `explorationReport` не переразмечается
    // между попытками). Ответ модели меняется — таблицы обязаны обновиться, а не остаться
    // прежними из-за того, что `deriveSchema` больше не видит поле строкой-образцом.
    const seen2 = { calls: [] as NormalizedCall[], warns: [] as string[] };
    const secondProvider = provider([], {
      map: '1. да | тарифная таблица и priceFor | второй проход: поправить edge-case\n2. нет\n3. нет\n',
      reuse: '1. нет\n2. нет\n3. нет\n',
    });
    const second = await executor(root, paths, { provider: secondProvider }).run(request(root, paths), hooks(seen2));
    ok(second.ok, second.note);
    const report = readFileSync(paths.explorationReport, 'utf8');
    ok(report.includes('второй проход: поправить edge-case'), report);
    ok(!report.includes('добавить вызов правила льготы'), 'старая строка карты пережила перезапись');
    ok(report.includes('_Ничего подходящего не найдено: да_'), report);
  });

  it('переиспользование не спрошено (лимит ходов) — не путается с честным «ничего не нашли»', async () => {
    const { root, paths } = setup(BLANK);
    const seen = { calls: [] as NormalizedCall[], warns: [] as string[] };
    const result = await executor(root, paths).run({ ...request(root, paths), maxTurns: 1 }, hooks(seen));
    const report = readFileSync(paths.explorationReport, 'utf8');
    ok(!report.includes('_Ничего подходящего не найдено: да_'), 'вопрос не задавался, а поле утверждает обратное');
    ok(!report.includes('_Ничего подходящего не найдено: нет_'), report);
    ok(result.note.includes('вопрос не задан') || (result.finalText ?? '').includes('вопрос не задан'), result.finalText);
  });

  it('«Прогон 2» готовности (поле этапа 4) не мешает гейту заполненности дойти до ✅', async () => {
    const { root, paths } = setup(BLANK);
    writeFileSync(
      paths.readiness,
      [
        '# Готовность',
        '',
        '## Прогон 1 — перед разведкой',
        '- **Дата:** 2026-01-01',
        '',
        '## Прогон 2 — перед планом',
        '- **Дата:** ‹дата›',
        '| # | Проверка | Статус |',
        '|---|---|---|',
        '| 1 | Блокирующие вопросы закрыты | ‹✅/❌› |',
        '',
        '**Вердикт прогона 2:** готова / не готова — ‹что чинить›',
      ].join('\n'),
    );
    const seen = { calls: [] as NormalizedCall[], warns: [] as string[] };
    const result = await executor(root, paths).run(request(root, paths), hooks(seen));
    ok(result.ok, result.note);
    const report = readFileSync(paths.explorationReport, 'utf8');
    ok(report.includes('- **Гейт «Заполненность артефактов»:** ✅'), report);
  });

  it('«yes»/«no» по-английски разбираются так же, как «да»/«нет»', async () => {
    const { root, paths } = setup(BLANK);
    const seen = { calls: [] as NormalizedCall[], warns: [] as string[] };
    const englishProvider = provider([], {
      map: '1. yes | тарифная таблица и priceFor | добавить вызов правила льготы\n2. no\n3. no\n',
      reuse: '1. yes | считает итог | вызываем после льготы\n2. no\n3. no\n',
    });
    const result = await executor(root, paths, { provider: englishProvider }).run(request(root, paths), hooks(seen));
    ok(result.ok, result.note);
    const report = readFileSync(paths.explorationReport, 'utf8');
    ok(report.includes('| src/tariffs.ts | тарифная таблица и priceFor | добавить вызов правила льготы |'), report);
    ok(!report.includes('| src/discounts.ts |'), 'файл с ответом «no» попал в карту');
    ok(report.includes('| priceFor | src/tariffs.ts:priceFor |'), 'переиспользование с «yes» не записано');
  });

  it('блокирующий вопрос без «|» не теряется; «1. нет вопросов» не становится пунктом', async () => {
    const { root, paths } = setup(BLANK);
    const seen = { calls: [] as NormalizedCall[], warns: [] as string[] };
    const provider2 = provider([], { questions: '1. блокирующий: применяется ли льгота к silver?\n2. нет вопросов\n' });
    const result = await executor(root, paths, { provider: provider2 }).run(request(root, paths), hooks(seen));
    ok(result.ok, result.note);
    const report = readFileSync(paths.explorationReport, 'utf8');
    ok(report.includes('- [ ] **[блокирующий]** применяется ли льгота к silver?'), report);
    ok(!report.includes('нет вопросов'), 'сентинел «нет вопросов» стал пунктом списка');
  });

  it('повторный проход по уже заполненным «Всплывшим вопросам» переписывает список, а не молчит', async () => {
    const { root, paths } = setup(BLANK);
    const seen1 = { calls: [] as NormalizedCall[], warns: [] as string[] };
    const first = await executor(root, paths).run(request(root, paths), hooks(seen1));
    ok(first.ok, first.note);
    const seen2 = { calls: [] as NormalizedCall[], warns: [] as string[] };
    const provider2 = provider([], { questions: '1. неблокирующий | Второй проход: новый вопрос\n' });
    const second = await executor(root, paths, { provider: provider2 }).run(request(root, paths), hooks(seen2));
    ok(second.ok, second.note);
    const report = readFileSync(paths.explorationReport, 'utf8');
    ok(report.includes('- [ ] **[неблокирующий]** Второй проход: новый вопрос'), report);
    ok(!report.includes('Распространяется ли льгота на silver?'), 'старый вопрос пережил перезапись');
  });

  it('бюджет исчерпан внутри вложенного добора — этап не притворяется завершённым', async () => {
    const { root, paths } = setup(BLANK);
    const seen = { calls: [] as NormalizedCall[], warns: [] as string[] };
    // Отчётный ход не отличим от штатного (провайдер отвечает тем же, чем базовый), но
    // каждый ответ несёт `costUsd`, и в вопросах вложенного `FormFillExecutor` (`- id:
    // \`конвенции\`` и далее) он же переводит `budgetHit()` за потолок. `nested.ok`
    // должен уронить весь этап — до фикса он терялся молча (ревью code-review-all,
    // 2026-09-11).
    const costingProvider: ChatProvider = {
      name: 'stub-cost',
      async chat(req: ChatRequest) {
        const base = await provider([]).chat(req);
        return { ...base, usage: { ...base.usage, costUsd: 10 } };
      },
    } as unknown as ChatProvider;
    const result = await executor(root, paths, { provider: costingProvider }).run(
      { ...request(root, paths), maxBudgetUsd: 5 },
      hooks(seen),
    );
    strictEqual(result.ok, false);
    ok(result.note.includes('дозаполнение свободных полей не завершено'), result.note);
  });
});

describe('конвейер разведки на реальном шаблоне эталона', { skip: METHODOLOGY === undefined ? 'SDLC_METHODOLOGY_DIR не задан — эталон методологии недоступен' : false }, () => {
  it('заполняет реальный бланк без плейсхолдеров кроме решения человека; страж карты доволен', async () => {
    const file = join(METHODOLOGY!, 'templates', 'exploration-report.template.md');
    ok(existsSync(file), `нет шаблона ${file}`);
    const { result, report, paths } = await scenario(readFileSync(file, 'utf8'), { axesEnabled: true });
    ok(result.ok, result.note);
    strictEqual(countPlaceholdersExceptDecisions(report), 0, report);
    ok(report.includes('**Решение человека о полноте:** ‹'), 'решение человека затронуто');
    ok(hasOpenQuestions(report));
    strictEqual(explorationPathProblem({ paths, chunk: 1, attempt: 1 }), null);
  });
});
