/**
 * Оракул выполнимости guided v5.
 *
 * Подменная модель с ЗАРАНЕЕ ИЗВЕСТНЫМИ верными ответами гоняется через настоящий конвейер
 * стенда: реальная фикстура задачи (`bench/fixtures/<семейство>`), реальный текст задачи и
 * банк ответов человека, реальная методология, реальные гейты, независимая приёмка в Docker
 * и скрытые тесты — ровно тот же путь, что проходит живая модель в `bench/src/cli.ts`
 * (`liveRun`), только провайдер подменён локальным HTTP-двойником.
 *
 * Зачем: четыре серии guided v5 (r1–r4, 2026-10-29/30) дали 0 успехов из 30 клеток, и ни одна
 * не отвечала на вопрос «а проходит ли конвейер хоть на верном ответе?». Валидаторы и подсказки
 * добавлялись по клеткам без эталона, и каждый новый страж мог отбраковать и правильный ответ.
 * Оракул — этот эталон: если верный ответ не доходит до handoff, дефект в конвейере, а не в
 * модели, и серия на живых моделях до починки бессмысленна.
 *
 * Оракул НЕ подглядывает в скрытые тесты: книги ответов написаны по тексту задачи и исходникам
 * фикстуры (то же, что видит модель). Книга ответов на задачу — данные теста, а не рантайма:
 * в `server/src` отсюда ничего не утекает.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { RunEvent, StageId } from '@sdlc-runner/shared';
import { WitokPaths } from '../../../server/src/artifacts/paths.ts';
import { loadConfig } from '../../../server/src/config/load.ts';
import type { LoadedConfig } from '../../../server/src/config/load.ts';
import { Run } from '../../../server/src/run/Run.ts';
import { readPersistedEvents } from '../../../server/src/eventLog.ts';
import { ApprovalBus, AskBus, attachOperator, emptyOperatorLog, readHumanScript } from '../operator.ts';
import type { OperatorDecisionLog } from '../operator.ts';
import { runBench } from '../driver.ts';
import type { DriverResult, DriverStageRecord } from '../driver.ts';
import { parseArgs, resolveTurnLimits } from '../options.ts';
import { buildProfile, readControl } from '../profile.ts';
import { prepareWorkspace } from '../workspace.ts';
import { requireTaskFiles } from '../tasks.ts';
import { prepareIndependentSuite } from '../independentSuite.ts';
import { runHiddenTests } from '../hiddenTests.ts';
import type { HiddenTestsSummary } from '../hiddenTests.ts';
import { simulatorDecisionQuestion } from './decisionPacket.ts';
import { ORACLE_BOOKS } from './oracleBooks.ts';
import type { OracleBook, OracleChunkInput } from './oracleBooks.ts';

const BENCH_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const ORACLE_TASKS = ['add-validator', 'config-default', 'rename-field', 'idempotent-retry', 'vat-rounding'] as const;
export type OracleTask = (typeof ORACLE_TASKS)[number];

/**
 * Задачи, которые guided v5 не доводит до handoff ДАЖЕ с верными ответами — и где именно
 * конвейер упирается. Это задокументированные пределы конвейера, а не дыры книги: тест оракула
 * требует от них ровно названного места остановки, чтобы снятие предела было видно как сдвиг.
 */
export const ORACLE_KNOWN_LIMITS: Partial<Record<OracleTask, { stages: readonly StageId[]; reason: string }>> = {
  'config-default': {
    // Останавливается либо на chunk (ремонт после диагноза сужается до split-схемы, которой
    // книге нечего ответить), либо на verify (правки применены, существующий тест формы красный,
    // две попытки с одним diff → escalate) — в зависимости от того, когда исчерпан бюджет ремонта.
    stages: ['chunk', 'verify'],
    reason: 'Задача велит обновить существующий тест внутри describe-блока; типизированный IR правит только объявления верхнего уровня '
      + '(syntaxIndex не индексирует вызовы describe/it), поэтому для существующего теста у модели нет ни одной применимой операции, '
      + 'а repairDiagnosisTargets не даёт ремонту взять существующий тест целью. Снимается общим расширением: индекс тест-кейсов как '
      + 'символов + замена statement по якорю.',
  },
};

export interface OracleRunOptions {
  task: OracleTask;
  /** Образ Docker для независимой приёмки; без него приёмка не регистрируется (как `--acceptance-image`). */
  image?: string | undefined;
  stageTimeoutMs?: number;
  runTimeoutMs?: number;
  keepWorkspace?: boolean;
  slug?: string;
  log?: (line: string) => void;
}

/** Одна запись журнала двойника: что спросили, что ответили, принял ли рантайм. */
export interface OracleExchange {
  seq: number;
  schema: string;
  questionId: string | null;
  stage: string | null;
  answer: unknown;
  /** Вход решения (усечённый JSON) — для разбора отказов без повторного прогона. */
  input: string;
  /** Двойник не нашёл ответа — вернул 400; это дыра книги ответов, а не конвейера. */
  unhandled?: string;
}

export interface OracleRunResult {
  task: OracleTask;
  stopped: DriverResult['stopped'];
  finalVerdict: DriverResult['finalVerdict'];
  stages: DriverStageRecord[];
  hidden: HiddenTestsSummary | null;
  exchanges: OracleExchange[];
  /** Отказы валидации рантайма по вопросам (событие `question_validation` с accepted=false). */
  rejections: { stage: string; questionId: string; reason: string }[];
  unhandled: string[];
  errors: string[];
  operator: OperatorDecisionLog;
  workspace: string | null;
  durationMs: number;
  /** Достижение цели оракула: виток дошёл до handoff с доверенным вердиктом passed. */
  reachedHandoff: boolean;
}

/** Генерический ответ по JSON-схеме — только для полей, которым книга не назначила значения. */
export function answerBySchema(schema: unknown, hint = ''): unknown {
  if (!schema || typeof schema !== 'object') return hint || 'н/п';
  const s = schema as Record<string, unknown>;
  if ('const' in s) return s.const;
  if (Array.isArray(s.enum) && s.enum.length) return s.enum[0];
  const branches = (s.oneOf ?? s.anyOf) as unknown[] | undefined;
  if (Array.isArray(branches) && branches.length) return answerBySchema(branches[0], hint);
  const type = Array.isArray(s.type) ? s.type[0] : s.type;
  if (type === 'string') {
    const min = typeof s.minLength === 'number' ? s.minLength : 1;
    const text = hint || 'н/п';
    return text.length >= min ? text : text.padEnd(min, '.');
  }
  if (type === 'integer' || type === 'number') return typeof s.minimum === 'number' ? s.minimum : 0;
  if (type === 'boolean') return false;
  if (type === 'null') return null;
  if (type === 'array') {
    const count = typeof s.minItems === 'number' ? s.minItems : 0;
    return Array.from({ length: count }, () => answerBySchema(s.items, hint));
  }
  if (type === 'object' || s.properties) {
    const properties = (s.properties ?? {}) as Record<string, unknown>;
    const required = new Set((s.required as string[] | undefined) ?? Object.keys(properties));
    return Object.fromEntries(Object.entries(properties).filter(([key]) => required.has(key)).map(([key, value]) => [key, answerBySchema(value, hint)]));
  }
  return hint || null;
}

/** Найти в схеме перечень допустимых evidenceId — рантайм закрывает его enum'ом. */
function enumOf(schema: unknown, property: string): string[] | null {
  let found: string[] | null = null;
  const walk = (node: unknown): void => {
    if (found || !node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    const record = node as Record<string, unknown>;
    const props = record.properties as Record<string, unknown> | undefined;
    const target = props?.[property] as Record<string, unknown> | undefined;
    const items = target?.items as Record<string, unknown> | undefined;
    if (Array.isArray(items?.enum)) { found = items!.enum as string[]; return; }
    if (Array.isArray(target?.enum)) { found = target!.enum as string[]; return; }
    Object.values(record).forEach(walk);
  };
  walk(schema);
  return found;
}

/** Двойник модели: отвечает по имени схемы ответа и книге задачи. */
export function createOracleAnswerer(book: OracleBook, exchanges: OracleExchange[]) {
  let seq = 0;
  let askedHuman = 0;
  return (request: any): unknown => {
    seq += 1;
    const format = request.response_format?.json_schema;
    const schema = format?.schema;
    const name: string = format?.name ?? '';
    const userText: string = request.messages?.findLast((m: any) => m.role === 'user')?.content ?? '';
    let packet: any = {};
    try { packet = JSON.parse(userText); } catch { /* не пакет решения */ }
    let input: any = packet;
    if (packet && packet.version === 1 && Array.isArray(packet.question) && packet.context) {
      // Пакет несёт все пользовательские сообщения: первое — данные этапа, последнее —
      // уточнение текущего под-вопроса (карточка плана, остаток плана, топология).
      const first = simulatorDecisionQuestion(packet, false);
      const last = simulatorDecisionQuestion(packet, true);
      const asObject = (value: unknown): any => typeof value === 'string' ? (() => { try { return JSON.parse(value); } catch { return { question: value }; } })() : value;
      input = { ...asObject(first), ...(packet.question.length > 1 ? { tail: asObject(last) } : {}), ...(packet.recovery ? { recovery: packet.recovery } : {}) };
    }
    const questionId: string | null = typeof input?.questionId === 'string' ? input.questionId : null;
    const stage: string | null = typeof packet?.context?.constraints?.stage === 'string' ? packet.context.constraints.stage : null;
    const record = (answer: unknown, unhandled?: string): unknown => {
      exchanges.push({ seq, schema: name, questionId, stage, answer, input: JSON.stringify(input).slice(0, 6000), ...(unhandled === undefined ? {} : { unhandled }) });
      return answer;
    };
    const fail = (why: string): never => { record(null, why); throw new Error(why); };

    // Отказ рантайма по прошлому ответу приходит полем recovery: книга отвечает одинаково,
    // и повтор без изменений означает, что отбраковка ложная — это и есть находка оракула.
    if (name === 'sdlc_form_fields') {
      const values: Record<string, unknown> = {};
      for (const [key, property] of Object.entries((schema?.properties ?? {}) as Record<string, any>)) {
        const text = book.formField(key, input, property);
        if (Array.isArray(property.enum)) {
          const options = property.enum as string[];
          values[key] = text !== null && options.includes(text) ? text : (options.find(option => /полн/iu.test(option)) ?? options[0]);
        } else values[key] = text ?? answerBySchema(property, `${key}: по тексту задачи`);
      }
      return record(values);
    }
    if (name === 'guided_field_items') return record({ items: book.fieldItems(input) });
    if (name === 'preparation_claims') return record(book.preparationClaims(schema, input));
    if (name === 'intent_claim_review' || name === 'intent_contract_review' || name === 'preparation_review_issues') return record({ issues: [] });
    if (name === 'preparation_review_scenarios') return record({ scenarios: book.reviewScenarios() });
    if (name === 'intent_issue_adjudication') return record({ relation: 'compatible', condition: 'Требование запроса', explanation: 'Требования согласованы между собой.', witness: 'Реализация по тексту задачи удовлетворяет обоим.' });
    if (name === 'intent_issue_batch') return record({ judgments: (input.issues ?? []).map((issue: any) => ({ issue: issue.issue, relation: 'compatible', condition: 'Требование запроса', explanation: 'Требования согласованы между собой.', witness: 'Реализация по тексту задачи удовлетворяет обоим.', conflict: null })) });
    if (name === 'guided_review') return record({ findings: [] });
    if (name === 'guided_claim') return record(book.claim(input));
    if (name === 'guided_failure_diagnosis') return record(book.failureDiagnosis(input, schema));
    if (name === 'guided_file_research') return record(book.fileResearch(input));
    if (name === 'guided_question_resolution') {
      const answer = book.questionResolution(input, schema, askedHuman);
      if (answer && typeof answer === 'object' && (answer as { kind?: string }).kind === 'human') askedHuman += 1;
      return record(answer);
    }
    if (name === 'guided_plan_outline') return record(book.planOutline(input, schema));
    if (name === 'guided_plan_card') return record(book.planCard(input, schema));
    if (name === 'guided_plan_remainder') return record(book.planRemainder(input, schema));
    if (name === 'guided_implementation_plan' || name === 'guided_compact_plan') return record(book.fullPlan(input, schema));
    if (name === 'guided_plan_repair_operations') return record(book.planRepair(input, schema));
    if (questionId?.startsWith('chunk:') || name === 'guided_action' || name === 'guided_whole_file') {
      const evidenceIds = enumOf(schema, 'evidenceIds') ?? [];
      const chunkInput: OracleChunkInput = { input, schema, evidenceIds, boundFile: typeof input.targetFile === 'string' ? input.targetFile : null,
        boundSymbol: typeof input.targetSymbol === 'string' ? input.targetSymbol : null };
      const answer = book.chunk(chunkInput);
      if (answer === null) return fail(`Книга ответов не знает файл chunk: ${JSON.stringify({ targetFile: input.targetFile, files: (input.files ?? []).map((f: any) => f.path), capabilities: input.capabilities })}`);
      return record(answer);
    }
    const generic = book.other(name, input, schema);
    if (generic !== undefined) return record(generic);
    return fail(`Неизвестная схема ответа: ${name}; questionId=${String(questionId)}; ${userText.slice(0, 300)}`);
  };
}

function oracleConfig(base: LoadedConfig, baseUrl: string): LoadedConfig {
  const limits = base.runner.limits;
  return {
    ...base,
    runner: {
      ...base.runner,
      operator: 'Бенчмарк',
      reviewModel: 'oracle:reviewer',
      limits: { ...limits, maxIterationsPerStage: 40, maxIterationsByStage: { ...limits.maxIterationsByStage, verify: 60 } },
    },
    models: {
      ...base.models,
      providers: { ...base.models.providers, oracle: { flow: 'loop', kind: 'openai-compat', baseUrl, swapsModels: false } },
      models: [
        ...base.models.models,
        { id: 'oracle:executor', provider: 'oracle', model: 'oracle-executor', rank: 50, contextWindow: 32768 },
        { id: 'oracle:reviewer', provider: 'oracle', model: 'oracle-reviewer', rank: 60, contextWindow: 32768, reviewFill: true, claimFill: true },
      ],
    },
  } as LoadedConfig;
}

/** Прогнать одну задачу стенда через настоящий конвейер на двойнике-оракуле. */
export async function runOracle(options: OracleRunOptions): Promise<OracleRunResult> {
  const book = ORACLE_BOOKS[options.task];
  if (!book) throw new Error(`Нет книги ответов оракула для задачи ${options.task}`);
  const log = options.log ?? (() => {});
  const exchanges: OracleExchange[] = [];
  const errors: string[] = [];
  const answer = createOracleAnswerer(book, exchanges);
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', part => { body += part; });
    req.on('end', () => {
      try {
        const request = JSON.parse(body);
        const value = answer(request);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: typeof value === 'string' ? value : JSON.stringify(value) }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 10 } }));
      } catch (error) {
        errors.push(String(error));
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: String(error) } }));
      }
    });
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;

  const slug = options.slug ?? `oracle-${options.task}-${Date.now().toString(36)}`;
  const argv = ['--model', 'oracle:executor', '--task', options.task, '--all', '--slug', slug, '--execution-mode', 'guided', '--guided-engine-version', '5', '--no-preflight',
    ...(options.image ? ['--acceptance-image', options.image] : [])];
  const opts = parseArgs(argv);
  const base = loadConfig();
  const config = oracleConfig(base, baseUrl);
  const control = readControl(join(BENCH_DIR, 'control.json'));
  const files = requireTaskFiles(BENCH_DIR, options.task);
  const taskText = readFileSync(files.taskFile, 'utf8');
  const branch = /`(sdlc\/[\w.\/-]+)`/u.exec(taskText)?.[1];
  if (!branch) throw new Error(`${files.taskFile}: в тексте задачи не названа ветка витка`);
  const script = readHumanScript(files.humanFile);
  const ws = await prepareWorkspace({ fixtureDir: files.fixtureDir, slug, branch });
  const traceDir = join(tmpdir(), `sdlc-oracle-${slug}`);
  mkdirSync(traceDir, { recursive: true });
  const built = buildProfile({ projectRoot: ws.root, models: config.models, control, opts });
  const approvalBus = new ApprovalBus();
  const askBus = new AskBus();
  const operatorLog = emptyOperatorLog();
  const events: RunEvent[] = [];
  const rejections: OracleRunResult['rejections'] = [];
  let runId = '';
  const operatorHandle = attachOperator({ strictQuestions: true, gate: approvalBus, askGate: askBus, runId: () => runId, script, log: operatorLog });
  const run = new Run({
    config, project: built.project, profile: built.profile, slug,
    gate: approvalBus.gate, askGate: askBus.gate,
    emit: (event) => {
      events.push(event);
      if (event.type === 'question_validation' && !event.accepted) rejections.push({ stage: event.stage, questionId: event.questionId, reason: event.reason });
      if (event.type === 'stage_started' || event.type === 'stage_done' || event.type === 'warning' || event.type === 'error') log(`${event.type}: ${JSON.stringify(event).slice(0, 400)}`);
    },
    budgetStages: new Set(built.measured),
  });
  runId = run.id;
  approvalBus.onResolved((info, decision) => run.noteApprovalDecision(info, decision));
  askBus.onAnswered((info) => run.noteQuestionsAnswered(info));
  const registerIndependent = options.image ? prepareIndependentSuite(BENCH_DIR, options.task, files.fixtureDir, join(traceDir, 'independent-suite'), options.image) : null;
  const startedAt = Date.now();
  let driver: DriverResult = { stages: [], finalVerdict: null, stopped: 'exception' };
  let hidden: HiddenTestsSummary | null = null;
  try {
    driver = await runBench({
      preparationVersion: 3, executionMode: 'guided', guidedEngineVersion: 5,
      run, stageTimeoutMs: options.stageTimeoutMs ?? 20 * 60_000, runTimeoutMs: options.runTimeoutMs ?? 60 * 60_000, attempts: 3,
      requirement: taskText, onDecision: log,
      ...(registerIndependent ? { onStageCompleted: async (record: DriverStageRecord) => {
        if (record.stage !== 'plan') return;
        const frozen = await registerIndependent(run);
        log(`независимая приёмка заморожена; baselinePassed=${frozen.baselinePassed}`);
      } } : {}),
    });
    const chunkRan = driver.stages.some(stage => stage.stage === 'chunk');
    if (chunkRan && existsSync(files.hiddenFile)) hidden = await runHiddenTests({ hiddenFile: files.hiddenFile, targetDir: ws.root, timeoutMs: 10 * 60_000 });
  } catch (error) {
    errors.push(String(error));
  } finally {
    operatorHandle.detach();
    await run.dispose();
    await new Promise<void>(done => { server.close(() => done()); server.closeAllConnections(); });
    writeFileSync(join(traceDir, 'exchanges.json'), JSON.stringify(exchanges, null, 1));
    try { writeFileSync(join(traceDir, 'events.json'), JSON.stringify(readPersistedEvents(ws.root, slug), null, 1)); } catch { /* лента недоступна */ }
    for (const path of [new WitokPaths(ws.root, slug).dir]) {
      try { if (existsSync(path)) writeFileSync(join(traceDir, 'witok-dir.txt'), path); } catch { /* нет */ }
    }
    if (!options.keepWorkspace) ws.dispose();
    else log(`рабочая копия оставлена: ${ws.root}`);
    if (!options.keepWorkspace) rmSync(traceDir, { recursive: true, force: true });
    else log(`трассы оракула: ${traceDir}`);
  }
  const unhandled = exchanges.filter(exchange => exchange.unhandled).map(exchange => exchange.unhandled!);
  return {
    task: options.task, stopped: driver.stopped, finalVerdict: driver.finalVerdict, stages: driver.stages, hidden, exchanges, rejections,
    unhandled, errors, operator: operatorLog, workspace: options.keepWorkspace ? ws.root : null, durationMs: Date.now() - startedAt,
    reachedHandoff: driver.stopped === 'handoff' && driver.finalVerdict?.passed === true,
  };
}

/** Короткая сводка для вывода теста/CLI: этапы, остановка, отказы, дыры книги. */
export function formatOracleResult(result: OracleRunResult): string {
  const stages = result.stages.map(stage => `${stage.stage}${stage.ok ? '✅' : '❌'}${stage.blockers.length ? `(блок: ${stage.blockers.join('; ').slice(0, 160)})` : ''}${stage.note ? ` — ${stage.note.slice(0, 160)}` : ''}`);
  const lines = [
    `оракул ${result.task}: остановка=${result.stopped}, вердикт=${result.finalVerdict ? `${result.finalVerdict.action}/${result.finalVerdict.passed}` : '—'}, ${Math.round(result.durationMs / 1000)} с`,
    ...stages.map(line => `  ${line}`),
  ];
  if (result.hidden) lines.push(`  скрытые тесты: ${result.hidden.pass}/${result.hidden.total}${result.hidden.errorText ? ` (${result.hidden.errorText.slice(0, 120)})` : ''}`);
  if (result.rejections.length) lines.push(`  отказы валидации (${result.rejections.length}):`, ...result.rejections.slice(0, 12).map(r => `    [${r.stage}] ${r.questionId}: ${r.reason.slice(0, 220)}`));
  if (result.unhandled.length) lines.push(`  дыры книги (${result.unhandled.length}):`, ...result.unhandled.slice(0, 6).map(u => `    ${u.slice(0, 300)}`));
  if (result.errors.length) lines.push(`  ошибки (${result.errors.length}):`, ...result.errors.slice(0, 6).map(e => `    ${e.slice(0, 300)}`));
  return lines.join('\n');
}

export type { StageId };
