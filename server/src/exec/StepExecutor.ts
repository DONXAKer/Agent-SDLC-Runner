/**
 * Флоу `loop`, этап 5 по шагам плана: рантайм ведёт цикл, модель отвечает на один шаг.
 *
 * Зачем. Замер r33 (`docs/model-runs.md`): из шести локальных моделей пять не дошли до
 * записи кода вовсе — пересказывали план словами, зацикливались на `AskHuman`,
 * останавливались после ответа человека, печатали «/sdlc-verify» текстом. Проверки на
 * пути записи (импорты, содержимое при промахе `Edit`, константы плана) им не помогли:
 * записи не было. Тот же порог методология уже сняла для документов режимом `formFill`
 * («порог „позвать инструмент“ у малого класса ниже порога „понять задачу“»); здесь та
 * же конструкция для кода:
 *
 *  - по одному шагу плана (`artifacts/planSteps.ts`) за запрос, обычным completion'ом
 *    без tool-use, с содержимым ровно ОДНОГО файла в контексте — блуждание по чтению и
 *    ловушка оболочки снимаются по построению;
 *  - существующий файл правится блоками `SEARCH/REPLACE`, новый — целиком. Файл целиком
 *    для существующего не принимается, и блок SEARCH, покрывающий файл целиком, — тоже:
 *    гард перезаписи (`approval/destructive.ts`) по построению «не про Edit», значит
 *    эту планку исполнитель обязан держать сам;
 *  - запись идёт через `hooks.onToolRequest` нормализованным `Write`/`Edit` — та же
 *    политика, тот же гейт одобрения; второго места решения о доступе не появляется;
 *  - после каждого шага — проверка рантаймом (`verifyTsImports` внутри инструмента,
 *    затем гейт набора проекта, если он есть). Красный даёт до ДВУХ ремонтных запросов с
 *    текстом ошибки и свежим содержимым файла (три ответа на шаг: первый ответ слабой
 *    модели часто промахивается фрагментом, второй чинит сам промах, третий — ошибку по
 *    существу; четвёртый уже не окупался бы); дальше шаг помечен ❌, переход к
 *    следующему. Ошибка видна у источника, а не на этап позже;
 *  - протокол «нечего делать»: ответ, состоящий из одной строки `БЕЗ ПРАВОК: причина`,
 *    помечает шаг ⏭ с причиной — вместо выдуманной правки ради правки.
 *
 * Что здесь НЕ происходит и названо честно:
 *  - `AskHuman` и `Task` в режиме нет. Подтверждение места правки человеком (Phase 2
 *    методологии) заменено картой шагов, которую рантайм показывает оператору до старта;
 *    вопрос, на который у модели нет ответа, обязан стать `БЕЗ ПРАВОК: требует решения
 *    человека: …`, а не выдумкой;
 *  - команда из поля «проверка» шага НЕ исполняется: это текст, написанный моделью на
 *    этапе 4, и запускать его без гейта одобрения значило бы обойти политику `Bash`.
 *    Проверяют гейты набора проекта; тесты прогоняет `recordAttemptEvidence` после этапа;
 *  - журнал chunk'а исполнитель не пишет: механику заполняет `autofillJournal`,
 *    содержательные поля — дозаполнение по полям с отчётом о шагах во входе;
 *  - улики по-прежнему пишет рантайм: шаг без diff'а — факт в отчёте, не «сделано»;
 *  - промпт этапа (`req.prompt`) в модель НЕ уходит: у шага свой запрос. Правка промпта
 *    оператором в панели на этот режим не действует — рантайм говорит это в карте шагов.
 *    Бриф ретрая («что не сошлось в прошлой попытке») подаётся в карточку шага отдельным
 *    полем: живой прогон 2026-09-02 показал, что без него попытка 2 чинит то, что видит в
 *    файле сама, а не то, что назвал рецензент.
 *
 * ИМЕНОВАННОЕ ИСКЛЮЧЕНИЕ из правила «всё, что уйдёт в модель, собрано в buildPrompt»: как
 * и у `FormFillExecutor`, запросы шагов несут свою обвязку (карточка шага, содержимое
 * файла, формат ответа). Обвязка шага — конструкция режима и меняется только правкой
 * кода. План и карточка фактов человека приходят из тех же источников, что у `buildPrompt`
 * (`humanFactsBlock`), а не собираются второй раз.
 */

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve } from 'node:path';

import type { Usage } from '@sdlc-runner/shared';
import { addUsage, emptyUsage, money } from '@sdlc-runner/shared';

import { describeStep, type PlanStep } from '../artifacts/planSteps.ts';
import type { ChatMessage, ChatProvider } from '../provider/ChatProvider.ts';
import { normalize } from './normalize.ts';
import type { ExecHooks, ExecRequest, StageExecutor, StageResult } from './StageExecutor.ts';
import { cap, executeTool, type ToolContext } from './tools/index.ts';

/**
 * Исход проверки после шага. `skipped` — проверка не состоялась (строки гейта нет, среда
 * не дала запуститься, таймаут): это НЕ зелёный, и в отчёте оно называется своим словом.
 */
export type StepCheck =
  | { status: 'ok' }
  | { status: 'skipped'; note: string }
  | { status: 'failed'; problem: string };

export interface StepExecutorOptions {
  provider: ChatProvider;
  /** Потолок содержимого файла/плана/брифа в контексте шага — окно локальной модели. */
  maxResultBytes: number;
  /** Нужны `ToolContext` по типу; `Read`/`Bash` отсюда недостижимы — исполняются только Write/Edit. */
  readRangeRequiredAboveBytes: number;
  bashTimeoutMs: number;
  params?: Record<string, unknown> | null;
  currency?: string;
  steps: readonly PlanStep[];
  /** Текст плана — для ориентира; режется по `maxResultBytes`. */
  planText: string;
  /** Блок «Факты от человека» из `buildPrompt`, либо пустая строка. */
  humanFacts: string;
  /** Бриф ретрая («что не сошлось в прошлой попытке») — `null` на первой попытке. */
  retryBrief: string | null;
  /**
   * Проверка после шага рантаймом: имя гейта (для отчёта) и прогон. `null` — в наборе
   * проекта нет включённой строки, и отчёт говорит «только импорты», а не молчит.
   */
  check: { name: string; run: (step: PlanStep) => Promise<StepCheck> } | null;
}

export type StepStatus = '✅' | '❌' | '⏭';

export interface StepOutcome {
  step: PlanStep;
  status: StepStatus;
  /** Что произошло — для отчёта и журнала. */
  note: string;
  /** Сколько запросов к модели ушло на шаг. */
  calls: number;
}

/** Сколько ремонтных запросов даётся шагу после первого ответа — см. шапку. */
const REPAIRS_PER_STEP = 2;

/** Доля файла, начиная с которой блок SEARCH считается переписыванием файла целиком. */
const WHOLE_FILE_SHARE = 0.8;
/** Файлы не длиннее этого планкой «переписывание» не охраняются — там нечего сокращать. */
const WHOLE_FILE_MIN_LINES = 5;

const NO_CHANGE_RE = /^\s*(?:`{3}[a-z]*\s*)?БЕЗ ПРАВОК\s*:\s*(.+?)\s*(?:`{3})?\s*$/iu;

/**
 * Блоки замены из ответа модели — построчно, маркеры только на отдельной строке.
 * Регулярка с ленивой группой цеплялась за `=======` внутри содержимого (комментарии-
 * разделители из знаков «=» в коде — обычное дело) и резала блок не по разделителю.
 * Пусто — блоков нет.
 */
export function parseSearchReplace(answer: string): { oldStr: string; newStr: string }[] {
  const out: { oldStr: string; newStr: string }[] = [];
  let state: 'idle' | 'search' | 'replace' = 'idle';
  let search: string[] = [];
  let replace: string[] = [];
  for (const line of answer.split(/\r?\n/)) {
    const t = line.trim();
    if (state === 'idle') {
      if (/^<{7}\s*SEARCH\s*$/.test(t)) {
        state = 'search';
        search = [];
        replace = [];
      }
      continue;
    }
    if (state === 'search') {
      if (/^={7}\s*$/.test(t)) state = 'replace';
      else search.push(line);
      continue;
    }
    if (/^>{7}\s*REPLACE\s*$/.test(t)) {
      const oldStr = search.join('\n');
      if (oldStr.trim() !== '') out.push({ oldStr, newStr: replace.join('\n') }); // пустой SEARCH совпал бы с чем угодно
      state = 'idle';
      continue;
    }
    replace.push(line);
  }
  return out;
}

/**
 * Содержимое нового файла из ответа: первый fenced-блок с закрытием С УЧЁТОМ ВЛОЖЕННОСТИ
 * (то же правило, что у `salvageBlocks`: ограждение с языком открывает вложенный блок,
 * голое — закрывает текущий уровень; markdown-файл с примером кода внутри иначе резался
 * по внутреннему закрытию). Без fence — сырой текст, если он не начинается с прозы.
 * `null` — брать нечего.
 */
export function parseFileContent(answer: string): string | null {
  const lines = answer.split(/\r?\n/);
  const open = lines.findIndex((l) => /^\s*```/.test(l));
  if (open >= 0) {
    let depth = 1;
    let end = lines.length;
    for (let j = open + 1; j < lines.length; j++) {
      const line = lines[j] ?? '';
      if (!/^\s*```/.test(line)) continue;
      if (/^\s*```\s*$/.test(line)) {
        depth -= 1;
        if (depth === 0) {
          end = j;
          break;
        }
      } else {
        depth += 1;
      }
    }
    const body = lines.slice(open + 1, end).join('\n');
    return body.trim() === '' ? null : `${body.replace(/\s+$/, '')}\n`;
  }
  const raw = answer.trim();
  if (raw === '' || /^[А-Яа-яЁё]/u.test(raw) || !raw.includes('\n')) return null;
  return `${raw}\n`;
}

/**
 * Причина из ответа, который ЦЕЛИКОМ есть `БЕЗ ПРАВОК: …`, либо `null`. Ответ с блоками
 * замены или содержимым файла сюда не попадает по построению — проверяется после разбора
 * блоков, иначе одна строка-комментарий модели отменяла готовую правку.
 */
export function noChangeReason(answer: string): string | null {
  const m = NO_CHANGE_RE.exec(answer);
  return m === null ? null : (m[1] ?? '').trim();
}

/** Отчёт о шагах — вход дозаполнения журнала и текст, которым этап отчитался. */
export function renderStepReport(outcomes: readonly StepOutcome[], checkName: string | null): string {
  const lines = [
    '## Шаги плана — отчёт рантайма (этап 5 по шагам, без tool-use)',
    '',
    checkName === null
      ? 'Проверка после шага: только импорты — включённой строки гейта сборки в наборе проекта нет.'
      : `Проверка после шага: импорты, затем гейт «${checkName}» (где он не состоялся — сказано в строке шага).`,
    '',
    ...outcomes.map((o) => `- ${o.status} ${describeStep(o.step)} — ${o.note} (запросов: ${o.calls})`),
  ];
  return lines.join('\n');
}

/**
 * Есть ли файл в HEAD проекта: `true`/`false` — репозиторий ответил, `null` — репозитория
 * нет или git недоступен (тогда охрана переписывания действует как для старого файла).
 *
 * Нужно гарду переписывания: он должен беречь файл, который существовал ДО chunk'а
 * (r33 — перезапись 156 строк в 55), а не файл, который эта же модель создала в попытке 1.
 * Без этого различия рецензент велит «переписать свой тест через priceFor», модель трижды
 * приносит переписанный файл, гард трижды отказывает, шаг красный — конфликт по построению
 * (bench, stepfill-v2).
 */
function trackedInHead(root: string, rel: string): boolean | null {
  const r = spawnSync('git', ['ls-tree', '--name-only', 'HEAD', '--', rel.replace(/\\/g, '/')], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (r.error !== undefined || r.status !== 0) return null;
  return r.stdout.trim() !== '';
}

/**
 * Содержимое файла шага — строго внутри корня проекта, по фактическому пути.
 * `null` — файла нет (новый) либо путь ведёт наружу (тогда шаг отклонит политика, а
 * содержимое чужого файла в промпт внешнему провайдеру не уедет — та же планка, что у
 * prefetch в `prompt/build.ts`).
 */
function readInsideRoot(root: string, rel: string): string | null {
  if (rel === '' || isAbsolute(rel)) return null;
  const abs = resolve(root, rel);
  const back = relative(root, abs);
  if (back.startsWith('..') || isAbsolute(back)) return null;
  if (!existsSync(abs)) return null;
  try {
    const realRoot = realpathSync(root);
    const real = realpathSync(abs);
    const realBack = relative(realRoot, real);
    if (realBack.startsWith('..') || isAbsolute(realBack)) return null;
    return readFileSync(real, 'utf8');
  } catch {
    return null;
  }
}

/** Файл с CRLF получает правки в CRLF: модель отдаёт LF, а `Edit` сверяет побайтно. */
function matchEol(current: string, s: string): string {
  return current.includes('\r\n') && !s.includes('\r') ? s.replace(/\n/g, '\r\n') : s;
}

const SYSTEM = [
  'Ты — исполнитель ОДНОГО шага одобренного плана в чужом проекте. Рантайм сам применяет',
  'твой ответ к файлу, сам прогоняет проверки, сам ведёт журнал и сам запускает тесты;',
  'инструментов у тебя нет, вопросов человеку — тоже: всё нужное уже в сообщении.',
  '',
  'Правила:',
  '- меняй только названный файл; другие файлы правятся другими шагами;',
  '- используй символы, которые называет план, а не выдумывай свои;',
  '- числа, пороги и формулировки из «фактов человека» и плана переноси ДОСЛОВНО;',
  '- не удаляй существующее поведение, если шаг этого не требует; не сокращай файл;',
  '- импортируй только то, что действительно экспортируется, с точностью до регистра;',
  '- если сделать шаг нельзя без решения человека — ответь ОДНОЙ строкой `БЕЗ ПРАВОК:',
  '  требует решения человека: <что именно>`, а не выдумывай значение;',
  '- никаких пояснений вне требуемого формата ответа.',
].join('\n');

const FORMAT_EDIT = [
  '## Формат ответа',
  '',
  'Верни ТОЛЬКО блоки замены, каждый строго в форме (маркеры — на отдельных строках):',
  '',
  '<<<<<<< SEARCH',
  'точный фрагмент текущего файла — скопируй дословно, с отступами',
  '=======',
  'новый текст вместо него',
  '>>>>>>> REPLACE',
  '',
  'Столько блоков, сколько нужно. Фрагмент SEARCH обязан встречаться в файле РОВНО один раз.',
  'Чтобы добавить код, возьми в SEARCH соседнюю существующую строку и повтори её в REPLACE.',
  'Не переписывай файл целиком — блок SEARCH на весь файл будет отклонён. Если для этого',
  'шага менять в файле нечего — весь ответ должен быть одной строкой `БЕЗ ПРАВОК: причина`.',
].join('\n');

const FORMAT_CREATE = [
  '## Формат ответа',
  '',
  'Файла ещё нет. Верни ПОЛНОЕ содержимое нового файла в одном блоке ```, ничего кроме блока.',
  'Если создавать файл для этого шага не нужно — весь ответ должен быть одной строкой',
  '`БЕЗ ПРАВОК: причина`.',
].join('\n');

export class StepExecutor implements StageExecutor {
  readonly flow = 'loop' as const;
  private readonly o: StepExecutorOptions;

  constructor(o: StepExecutorOptions) {
    this.o = o;
  }

  async run(req: ExecRequest, hooks: ExecHooks): Promise<StageResult> {
    if (this.o.steps.length === 0) {
      return {
        ok: false,
        finalText: '',
        usage: emptyUsage(),
        note: 'этап по шагам: в плане не нашлось ни одного шага с файлом — исполнять нечего',
      };
    }

    const toolCtx: ToolContext = {
      projectRoot: req.cwd,
      maxResultBytes: this.o.maxResultBytes,
      readRangeRequiredAboveBytes: this.o.readRangeRequiredAboveBytes,
      timeoutMs: this.o.bashTimeoutMs,
      signal: req.signal,
    };
    const currency = this.o.currency ?? 'USD';
    const checkName = this.o.check?.name ?? null;
    let usage: Usage = emptyUsage();
    let callsTotal = 0;
    const outcomes: StepOutcome[] = [];
    const total = this.o.steps.length;
    const planBlock = cap(this.o.planText, this.o.maxResultBytes);
    const factsBlock = cap(this.o.humanFacts.trim(), this.o.maxResultBytes);
    const briefBlock = this.o.retryBrief === null ? '' : cap(this.o.retryBrief.trim(), this.o.maxResultBytes);

    const stop = (note: string): StageResult => ({
      ok: false,
      finalText: renderStepReport(outcomes, checkName),
      usage,
      note,
    });

    const budgetHit = (): string | null => {
      const spent = usage.costUsd === null ? null : usage.costUsd + (req.spentUsdBefore ?? 0);
      if (req.maxBudgetUsd !== null && spent !== null && spent >= req.maxBudgetUsd) {
        return `бюджет прогона исчерпан: ${money(spent, currency)} из ${money(req.maxBudgetUsd, currency)}`;
      }
      return null;
    };

    const chat = async (messages: ChatMessage[]): Promise<string> => {
      const answer = await this.o.provider.chat({
        model: req.model,
        messages,
        tools: [],
        signal: req.signal,
        temperature: null,
        params: this.o.params ?? null,
      });
      callsTotal++;
      usage = addUsage(usage, answer.usage);
      hooks.onUsage(answer.usage);
      if (answer.text !== '') hooks.onText(answer.text);
      return answer.text;
    };

    /** Применение ответа через гейт. `denied` — отказ окончательный, ремонт не нужен. */
    const apply = async (
      step: PlanStep,
      current: string | null,
      answer: string,
    ): Promise<{ ok: boolean; text: string; denied: boolean; noChange: string | null }> => {
      let toolName: 'Write' | 'Edit';
      let rawInput: Record<string, unknown>;
      if (current !== null) {
        const edits = parseSearchReplace(answer);
        if (edits.length === 0) {
          const reason = noChangeReason(answer);
          if (reason !== null) return { ok: true, text: reason, denied: false, noChange: reason };
          return {
            ok: false,
            denied: false,
            noChange: null,
            text:
              'в ответе нет ни одного блока `<<<<<<< SEARCH … ======= … >>>>>>> REPLACE` — ' +
              'правку применить не к чему. Ответь блоками замены по формату.',
          };
        }
        // Планка «переписывание» — для файлов, где есть что переписывать: у файла в
        // несколько строк любая правка покрывает его целиком, и это не перезапись. Файл,
        // которого в HEAD нет (создан этим же chunk'ом), охраны не получает — см. trackedInHead.
        const whole =
          current.split('\n').length <= WHOLE_FILE_MIN_LINES || trackedInHead(req.cwd, step.file) === false
            ? undefined
            : edits.find(
                (e) =>
                  e.oldStr.trim() === current.trim() ||
                  Buffer.byteLength(e.oldStr, 'utf8') >= WHOLE_FILE_SHARE * Buffer.byteLength(current, 'utf8'),
              );
        if (whole !== undefined) {
          return {
            ok: false,
            denied: false,
            noChange: null,
            text:
              'блок SEARCH покрывает файл целиком (или почти целиком) — так файл переписывается, ' +
              'а не правится. Возьми в SEARCH только тот фрагмент, который меняется.',
          };
        }
        toolName = 'Edit';
        rawInput = {
          file_path: step.file,
          edits: edits.map((e) => ({
            old_string: matchEol(current, e.oldStr),
            new_string: matchEol(current, e.newStr),
          })),
        };
      } else {
        const content = parseFileContent(answer);
        if (content === null) {
          const reason = noChangeReason(answer);
          if (reason !== null) return { ok: true, text: reason, denied: false, noChange: reason };
          return {
            ok: false,
            denied: false,
            noChange: null,
            text: 'в ответе нет блока ``` с содержимым файла — создавать нечего. Верни файл целиком в одном блоке.',
          };
        }
        toolName = 'Write';
        rawInput = { file_path: step.file, content };
      }

      const call = normalize(toolName, rawInput);
      const requestId = `step:${randomUUID()}`;
      const decision = await hooks.onToolRequest(call, {
        requestId,
        toolName,
        rawInput,
        callerTools: req.allowedTools,
      });
      if (!decision.allowed) {
        hooks.onFriction('denied');
        hooks.onToolResult({ requestId, ok: false, summary: decision.reason, durationMs: 0 });
        return { ok: false, denied: true, noChange: null, text: `запись отклонена: ${decision.reason}` };
      }
      const effective =
        decision.updatedInput === null
          ? call
          : normalize(toolName, decision.updatedInput as Record<string, unknown>);
      const started = Date.now();
      const outcome = await executeTool(effective, toolCtx);
      hooks.onToolResult({
        requestId,
        ok: outcome.ok,
        summary: outcome.text.split('\n')[0]?.slice(0, 200) ?? '',
        durationMs: Date.now() - started,
      });
      return { ok: outcome.ok, denied: false, noChange: null, text: outcome.text };
    };

    for (const [idx, step] of this.o.steps.entries()) {
      if (req.signal.aborted) return stop('этап отменён');
      const over = budgetHit();
      if (over !== null) {
        hooks.onWarn(over);
        return stop(over);
      }

      const before = readInsideRoot(req.cwd, step.file);
      const messages: ChatMessage[] = [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: this.stepMessage(step, idx + 1, total, planBlock, factsBlock, briefBlock, before) },
      ];

      let calls = 0;
      let status: StepStatus = '❌';
      let note = '';
      let problem: string | null = null;
      let lastAnswer: string | null = null;
      /** Содержимое файла на момент ТЕКУЩЕГО раунда — существование считается заново после записи. */
      let current = before;

      for (let round = 0; round <= REPAIRS_PER_STEP; round++) {
        // Лимит ходов этапа действует и здесь: без него fallback-план на 25 строк давал
        // до 75 запросов и 75 сборок, а бюджет на локальном провайдере (`costUsd: null`)
        // не срабатывает вовсе.
        if (callsTotal >= req.maxTurns) {
          outcomes.push({ step, status: '❌', note: `не начат: исчерпан лимит ходов этапа (${req.maxTurns})`, calls });
          return stop(`исчерпан лимит ходов этапа (${req.maxTurns})`);
        }
        if (round > 0) {
          current = readInsideRoot(req.cwd, step.file);
          // Ремонт держит только последнюю пару «ответ/замечание»: три раунда с полным
          // файлом в каждом не влезали в окно 16k, и первым вытеснялся system.
          messages.splice(2, Math.max(0, messages.length - 3));
          const becameExisting = before === null && current !== null;
          messages.push({
            role: 'user',
            content: [
              '## Проверка после применения не прошла',
              '',
              '```',
              cap(problem ?? '', this.o.maxResultBytes),
              '```',
              '',
              'Ошибки в ДРУГИХ файлах не чини — они закрываются другими шагами.',
              '',
              ...(current === null
                ? []
                : [`## Текущее содержимое ${step.file} (после твоей правки)`, '', '```', cap(current, this.o.maxResultBytes), '```', '']),
              becameExisting
                ? 'Файл теперь существует: верни исправление блоками SEARCH/REPLACE по содержимому выше, ' +
                  'а не файл целиком.'
                : current !== null
                  ? 'Верни исправление блоками SEARCH/REPLACE по ТЕКУЩЕМУ содержимому выше.'
                  : 'Верни исправленный файл целиком в одном блоке ```.',
            ].join('\n'),
          });
        }

        let answer: string;
        try {
          answer = await chat(messages);
        } catch (e) {
          if (req.signal.aborted) return stop('этап отменён');
          throw e;
        }
        calls++;
        messages.push({ role: 'assistant', content: answer, toolCalls: [] });

        // Ремонтное замечание, на которое модель отвечает тем же текстом побайтно, её не
        // достигает: третий раунд с тем же ответом стоил бы ещё один полный файл в контексте
        // и ту же проверку. Шаг закрывается сразу — как красный, с названной причиной.
        if (round > 0 && answer === lastAnswer) {
          status = '❌';
          note = `ремонт остановлен: ответ повторён дословно — ${note}`;
          break;
        }
        lastAnswer = answer;

        const applied = await apply(step, current, answer);

        if (applied.noChange !== null) {
          status = '⏭';
          note = `без правок: ${applied.noChange}`;
          break;
        }
        if (applied.denied) {
          status = '❌';
          note = applied.text;
          break;
        }
        if (!applied.ok) {
          problem = applied.text;
          note = applied.text.split('\n')[0] ?? applied.text;
          continue;
        }

        const check: StepCheck = this.o.check === null ? { status: 'ok' } : await this.o.check.run(step);
        if (check.status === 'ok') {
          status = '✅';
          note = applied.text.split('\n')[0] ?? 'применено';
          break;
        }
        if (check.status === 'skipped') {
          status = '✅';
          note = `${applied.text.split('\n')[0] ?? 'применено'}; проверка после шага не состоялась: ${check.note}`;
          break;
        }
        // Красная сборка, в которой файл шага не упомянут, — чужая: порядок fallback-шагов
        // не порядок зависимостей, и импорт из ещё не написанного файла краснеет законно.
        // Ремонт здесь подталкивал бы убрать верный импорт. Проверят следующие шаги и
        // прогон тестов после этапа.
        if (!check.problem.includes(basename(step.file))) {
          status = '✅';
          note =
            `${applied.text.split('\n')[0] ?? 'применено'}; гейт «${checkName ?? ''}» красный вне этого файла: ` +
            `${check.problem.split('\n')[0] ?? ''}`;
          hooks.onWarn(`шаг ${step.n}: ${note}`);
          break;
        }
        problem = check.problem;
        note = `после правки проверка красная: ${check.problem.split('\n')[0] ?? check.problem}`;
      }

      outcomes.push({ step, status, note, calls });
      hooks.onWarn(`шаг ${step.n} из ${total}: ${status} ${note}`);
    }

    const report = renderStepReport(outcomes, checkName);
    const bad = outcomes.filter((o) => o.status === '❌').length;
    const done = outcomes.filter((o) => o.status === '✅').length;
    const skipped = outcomes.filter((o) => o.status === '⏭').length;
    const summary = `шагов ${outcomes.length}: применено ${done}, без правок ${skipped}, красных ${bad}`;
    // Этап закрыт, если хоть один шаг дал правку — красный шаг его не роняет. Красный шаг
    // (проверка после трёх ремонтов так и не позеленела) — это дерево с красным тестом, и
    // судить его — работа этапа 6: рецензент назовёт причину брифом на следующую попытку. В
    // обычном цикле модель с красным тестом этап тоже завершает. Правило «красный шаг =
    // провал этапа» отняло у qwen3-coder-30b-a3b второе ревью при дереве 9/9 по эталону:
    // единственный красный был неверным ожиданием в её же тесте, драйвер прочитал не-ok как
    // «заблокировано» и остановил виток без вердикта (bench, stepfill-v2).
    return {
      ok: done > 0,
      finalText: report,
      usage,
      note: done === 0 ? `${summary} — ни один шаг не дал правки` : bad === 0 ? summary : `${summary} — красные шаги на суд этапа 6`,
    };
  }

  private stepMessage(
    step: PlanStep,
    n: number,
    total: number,
    planBlock: string,
    factsBlock: string,
    briefBlock: string,
    content: string | null,
  ): string {
    const card = [
      `## Шаг ${n} из ${total} — ${step.title}`,
      '',
      `- файл: \`${step.file}\` (${content === null ? 'новый' : 'существующий'})`,
      ...(step.symbol === null ? [] : [`- символ: \`${step.symbol}\``]),
      `- действие: ${step.action}`,
      ...(step.claims.length === 0 ? [] : [`- закрывает пункты приёмки: ${step.claims.join(', ')}`]),
      // Команда проверки — справка о том, чем шаг ПОТОМ проверят, а не поручение её запустить.
      ...(step.check === null ? [] : [`- чем проверяется после этапа: \`${step.check}\`${step.expect === null ? '' : ` · ожидаемо: ${step.expect}`}`]),
      ...(step.facts === null ? [] : [`- факты человека для этого шага: ${step.facts}`]),
    ];
    const parts = [
      card.join('\n'),
      '',
      '## План витка (для ориентира — правишь только файл шага)',
      '',
      '```md',
      planBlock,
      '```',
    ];
    if (factsBlock !== '') parts.push('', factsBlock);
    if (briefBlock !== '') parts.push('', briefBlock);
    if (content !== null) {
      parts.push('', `## Текущее содержимое \`${step.file}\``, '', '```', cap(content, this.o.maxResultBytes), '```');
    }
    parts.push('', content === null ? FORMAT_CREATE : FORMAT_EDIT);
    return parts.join('\n');
  }
}
