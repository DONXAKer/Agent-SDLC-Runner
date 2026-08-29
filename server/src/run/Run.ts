/**
 * Машина витка: один прогон одного этапа за раз.
 *
 * Состояние живёт на диске, в `.sdlc/<slug>/` целевого проекта, а не в памяти процесса.
 * Поэтому предусловия проверяются чтением файлов: виток переживает перезапуск сервиса,
 * а начатый в терминале скиллами `/sdlc-*` продолжается здесь и наоборот.
 */

import { randomUUID } from 'node:crypto';

import type {
  NormalizedCall,
  Decision,
  EventSink,
  GateRunResult,
  GateStatus,
  McpServerInfo,
  ToolName,
  PolicyContext,
  PreparedPrompt,
  RunStatus,
  StageId,
  Usage,
  IterationSummary,
  RedCause,
  RedCauseKind,
  RunMetrics,
  Verdict,
  VerdictInput,
} from '@sdlc-runner/shared';
import { addUsage, emptyUsage } from '@sdlc-runner/shared';

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  branchNameFromField,
  decisionValue,
  readArtifact,
  readField,
  setDecision,
  writeArtifact,
} from '../artifacts/artifact.ts';
import { WitokPaths, artifactPathOf, isArtifactKey } from '../artifacts/paths.ts';
import { appendScopeExtension, extractFilesToTouch } from '../artifacts/planFiles.ts';
import { columnIndex, parseTables } from '../md/table.ts';
import type { AskGate } from '../approval/askGate.ts';
import type { ApprovalGate } from '../approval/gate.ts';
import type { LoadedConfig } from '../config/load.ts';
import { EMPTY_MCP, rulesForStage } from '../config/mcp.ts';
import { effectiveMode } from '../policy/mcp.ts';
import { missingNow, seedArtifacts, stillMissing, untouchedSeeds } from './seed.ts';
import type { McpSetup } from '../config/mcp.ts';
import { McpHub } from '../mcp/McpHub.ts';
import { imageSaver } from '../mcp/content.ts';
import { estimateTokens, selectTools } from '../mcp/select.ts';
import type { McpToolInfo } from '../mcp/types.ts';
import { cap } from '../exec/tools/index.ts';
import type { ProjectConfig, ResolvedProfile, ResolvedRoute } from '../config/schema.ts';
import { LoopExecutor } from '../exec/LoopExecutor.ts';
import { normalize } from '../exec/normalize.ts';
import { SdkExecutor } from '../exec/SdkExecutor.ts';
import { createProvider } from '../provider/registry.ts';
import type {
  ExecHooks,
  FrictionKind,
  McpAccess,
  StageExecutor,
  StageResult,
  SubagentDef,
} from '../exec/StageExecutor.ts';
import { loadSubagents } from '../exec/subagents.ts';
import type { GatesFile } from '../gates/gatesFile.ts';
import { configProblems, gateKey, parseGates, uncalibratedGates, unimplementedGates } from '../gates/gatesFile.ts';
import { builtinFor, describeBuild, snapshotBaseline } from '../gates/builtin/index.ts';
import { currentBranch, isRepo } from '../gates/git.ts';
import { runGateByName, runGates } from '../gates/run.ts';
import { workingDiff } from '../gates/git.ts';
import type { BuiltinGate, GateContext } from '../gates/builtin/index.ts';
import { recordAttemptEvidence } from './evidence.ts';
import type { TreeChange } from './evidence.ts';
import { salvageBlocks } from './salvage.ts';
import { preflightBlockers } from '../sandbox/preflight.ts';
import { collectVerdictInput, manualClaimIds } from '../verdict/collect.ts';
import { diffCloseness } from './diffDistance.ts';
import { classifyRedVerdict } from '../verdict/classify.ts';
import { buildRetryBrief } from '../verdict/retryBrief.ts';
import { appendIteration, parseIterations } from './iterationsLog.ts';
import { postmortemBlock } from './postmortem.ts';
import { suggestEscalation } from './escalation.ts';
import type { Escalation } from './escalation.ts';
import { computeVerdict } from '../verdict/verdict.ts';
import { buildPrompt } from '../prompt/build.ts';
import {
  checkPreconditions,
  stageById,
  type PreconditionReport,
  type StageContext,
  type StageDef,
} from './stages.ts';

export interface RunOptions {
  config: LoadedConfig;
  project: ProjectConfig;
  profile: ResolvedProfile;
  slug: string;
  gate: ApprovalGate;
  askGate: AskGate;
  emit: EventSink;
}

export interface RunStageOptions {
  prompt?: PreparedPrompt;
  requirement?: string;
  extra?: string;
  /** Оператор объявил обрыв витка — handoff оформляется без зелёного вердикта. */
  abortHandoff?: boolean;
}

/** Этапы, после которых запись ограничена одобренным планом. */
const PLAN_SCOPED_STAGES: readonly StageId[] = ['chunk', 'verify', 'handoff'];

/**
 * Итоги прогона гейтов для входа рецензента.
 *
 * Дословный вывод команды не подклеиваем: сборка печатает мегабайты, а рецензенту нужен
 * статус и последняя содержательная строка. Полный вывод остаётся в шине событий.
 */
function gateReportBlock(results: readonly GateRunResult[]): string {
  // Вертикальная черта экранируется, как требует форма набора. Без этого команда или
  // строка ошибки с трубой (`grep 'a|b'`, вывод junit) разъезжает по колонкам, а
  // разъехавшуюся таблицу рецензент переносит в отчёт — там сдвинутая колонка «Статус»
  // читается как `⏭` и роняет вердикт по несуществующей причине.
  const cell = (v: string): string => v.split('\n').join(' ').split('|').join('\\|');

  const rows = results.map(
    (r) =>
      `| ${cell(r.name)} | ${r.status} | ${cell(r.command ?? 'встроенная проверка')} · код ${
        r.exitCode ?? '—'
      } · ${r.durationMs} мс |\n| | | ${cell(r.lastLine)} |`,
  );
  return [
    '## Итоги автоматических гейтов (прогон рантайма, этот этап)',
    '',
    'Эти статусы получены фактическим прогоном до начала ревью. Переписывать их своим',
    'мнением нельзя: в отчёт они переносятся как есть, а вердикт считается по худшему из',
    'двух — твоего и фактического. Твоя работа — §1–§5 отчёта и поиск того, чего гейты',
    'не видят.',
    '',
    '| Гейт | Статус | Результат |',
    '|---|---|---|',
    ...rows,
  ].join('\n');
}

/**
 * Дописывает к промпту оператора блок фактов, которых на момент правки ещё не было.
 *
 * Повторно не подклеивает: если оператор собрал промпт после прогона гейтов, блок уже
 * внутри, и второй экземпляр только сбил бы рецензента.
 */
function withExtra(prompt: PreparedPrompt, block: string | undefined): PreparedPrompt {
  if (block === undefined || block === '' || prompt.user.includes(block)) return prompt;
  return { ...prompt, user: `${prompt.user}\n\n${block}` };
}

/**
 * Субагенты, вызов которых засчитывается как состоявшееся независимое ревью.
 *
 * Реестр, а не подстрока в имени: от этого списка зависит зелёный статус гейта из
 * минимальной пятёрки, и расширяться он должен осознанно.
 */
const REVIEWER_AGENTS: readonly string[] = ['sdlc-reviewer'];

/** Гейт минимума, который рантайм не исполняет скриптом. */
const REVIEW_GATE = 'Ревью независимым агентом';

/**
 * Восстанавливает номер последней попытки chunk'а из журнала на диске.
 *
 * Новый `Run` в памяти всегда стартовал с попытки 1, даже если на диске уже лежат
 * артефакты попытки 3 — например, после рестарта сервера (виток живёт на диске, но
 * счётчик попытки был только в памяти процесса). Предусловие этапа верификации требует
 * `chunk-<N>-attempt-<K>-diff.patch` по ТЕКУЩЕМУ счётчику и падало «нет файла», хотя
 * реальный файл существовал под другим номером — единственным обходом было вручную
 * «прокликать» attempt 1→2→3 через кнопку «Новая попытка», рискуя случайно перезапустить
 * дорогой этап вместо того, чтобы просто продолжить его просмотр.
 */
/**
 * Восстанавливает номер ТЕКУЩЕГО chunk'а по файлам витка на диске.
 *
 * `restoreAttemptFromJournal` ниже чинит попытку внутри chunk'а, но сам `this.chunk`
 * до его вызова был захардкожен единицей в поле класса — рестарт процесса на chunk'е 3
 * откатывал счётчик в памяти на chunk 1, и `restoreAttemptFromJournal` смотрела не в тот
 * журнал вовсе. Наблюдение живого витка: случайный клик «Следующий chunk» сдвинул
 * состояние, откатить смог только `docker restart`, потому что перезапуск НЕ восстанавливал
 * то, что должен был. Берём наибольший `N`, для которого на диске есть `chunk-N-journal.md`
 * — тот же признак «chunk начался», на который опирается `restoreAttemptFromJournal`.
 */
function restoreChunkFromDir(dir: string): number | null {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  let max = 0;
  for (const name of entries) {
    const m = /^chunk-(\d+)-journal\.md$/.exec(name);
    if (m === null) continue;
    const n = Number.parseInt(m[1] as string, 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max > 0 ? max : null;
}

function restoreAttemptFromJournal(journalPath: string): number | null {
  if (!existsSync(journalPath)) return null;
  let text: string;
  try {
    text = readFileSync(journalPath, 'utf8');
  } catch {
    return null;
  }
  const table = parseTables(text).find((t) => t.section === 'Попытки');
  if (table === undefined || table.rows.length === 0) return null;
  const col = columnIndex(table.header, 'K');
  if (col === -1) return null;
  let max = 0;
  for (const row of table.rows) {
    const n = Number.parseInt(row[col] ?? '', 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max > 0 ? max : null;
}

/** Пустая строка трения. Функция, а не константа: объект здесь мутируется на месте. */
function EMPTY_FRICTION(): {
  repeat: number;
  badJson: number;
  denied: number;
  truncated: number;
  toolCalls: number;
  reminders: number;
} {
  return { repeat: 0, badJson: 0, denied: 0, truncated: 0, toolCalls: 0, reminders: 0 };
}

export class Run {
  readonly id = randomUUID();
  readonly project: ProjectConfig;
  readonly profile: ResolvedProfile;
  readonly slug: string;
  readonly paths: WitokPaths;

  chunk = 1;
  attempt = 1;
  status: RunStatus = 'idle';
  totalUsage: Usage = emptyUsage();

  private readonly config: LoadedConfig;
  private readonly gate: ApprovalGate;
  private readonly askGate: AskGate;
  private readonly emit: EventSink;
  private aborter: AbortController | null = null;
  /** Фактический прогон гейтов текущей попытки — источник статусов для вердикта. */
  private lastGateResults: GateRunResult[] = [];
  private lastGatesAborted = false;
  /**
   * Последний посчитанный `preflightBlockers` для `verify` — не «живой» результат (Docker
   * не опрашивается на каждый вызов `blockers()`, только когда сам `runStage` реально его
   * посчитал), но лучше, чем ничего: `blockers()` синхронный и вызывается из GET-ручек на
   * каждый опрос списка витков — дёргать Docker на каждый такой опрос было бы дороже, чем
   * не показывать pre-flight-статус в списке заранее вовсе. Обновляется в `runStage`, тем
   * же местом, где сегодня и вычисляется актуальный pre-flight.
   */
  private lastPreflightBlockers: string[] = [];
  /** Вход последнего посчитанного вердикта — из него собирается выжимка для ретрая. */
  private lastVerdictInput: VerdictInput | null = null;
  /**
   * Выжимка причин прошлого красного, ждущая следующей попытки chunk'а.
   *
   * Живёт на chunk, а не на попытку: `resetAttemptState` обнуляет вердикт и итоги гейтов,
   * поэтому собрать её ПОСЛЕ сброса уже не из чего — она собирается до него, в
   * `nextAttempt`, и переживает сброс намеренно.
   */
  private carryForward: string | null = null;
  private verdict: Verdict | null = null;
  /** Куда возвращать виток по природе красного. На `passed` не влияет. */
  private redCause: RedCause | null = null;
  /** Близость патча этой попытки к предыдущей. `null` — считать не из чего. */
  private closeness: number | null = null;
  /**
   * Числа витка. НЕ сбрасываются в `resetAttemptState`: там обнуляется состояние попытки,
   * а метрики принадлежат витку — иначе «сколько итераций съел виток» опять станет
   * невосстановимым.
   */
  private readonly stageStats = new Map<StageId, { runs: number; usage: Usage; durationMs: number }>();
  private readonly attemptsByChunk = new Map<number, number>();

  /**
   * Трение цикла по этапам. Считается рантаймом, а не рассказывается моделью: она про
   * свои повторы и обрезанные результаты не знает, а числа отсюда — наблюдение.
   */
  private readonly friction = new Map<
    StageId,
    {
      repeat: number;
      badJson: number;
      denied: number;
      truncated: number;
      /** Сколько вызовов инструментов этап сделал ВСЕГО. Ноль — сам по себе диагноз. */
      toolCalls: number;
      /** Сколько раз страж завершения возвращал модель доделывать артефакт. */
      reminders: number;
    }
  >();

  /** Внешние MCP-серверы витка: набор задан конфигом проекта, соединения — ленивые. */
  private readonly mcpSetup: McpSetup;
  private readonly hub: McpHub;
  /** Набор MCP-инструментов последнего запуска этапа — для панели и для показа промпта. */
  private mcpSelected: McpToolInfo[] = [];
  /** Счётчик сохранённых картинок витка: имена файлов не должны затирать друг друга. */
  private mcpImageSeq = 0;
  /** Счётчик спасённых из текста записей: идентификатор вызова обязан быть уникальным. */
  private salvageSeq = 0;
  /**
   * Что стало с деревом за последнюю попытку этапа 5.
   *
   * Три значения, а не булево: «не знаем» (запись улик упала) обязано отличаться от
   * «правки были», иначе попытка с неизвестным состоянием дерева проходит как нормальная —
   * ровно та дыра, ради закрытия которой улики и отобраны у агента.
   */
  private chunkTree: TreeChange = 'unknown';
  /**
   * Сколько попыток этого chunk'а закончились «красным из-за окружения».
   *
   * Вычитается из счётчика при сверке с бюджетом: методология требует, чтобы дефект среды
   * не занимал попытку, а хранение этого через НЕувеличение номера стоило бы перезаписи
   * улик предыдущей попытки. Сбрасывается вместе с номером на новом chunk'е.
   */
  private envBlockedAttempts = 0;
  /** Формы, разложенные под артефакты текущего этапа, — их называет промпт. */
  private seeded: string[] = [];
  /**
   * Проваленные пункты приёмки по попыткам текущего chunk'а — вход эскалации.
   * Живёт на chunk: `resetAttemptState` обнуляет состояние ПОПЫТКИ, а история попыток
   * нужна именно между ними.
   */
  private failedClaimsByAttempt: string[][] = [];
  /** История попыток для интерфейса — тот же набор фактов, что уходит в `iterations.md`. */
  private readonly iterationLog: IterationSummary[] = [];
  private verdictCount = 0;
  /**
   * `chunk:attempt`, для которых статистика вердикта уже учтена. `null` — ещё нет.
   *
   * Повторный запуск этапа 6 на той же попытке — обычное действие оператора (например
   * после правки набора гейтов). Без этой отметки он дописывал вторую строку в журнал
   * итераций про ту же попытку, дублировал проваленные пункты приёмки, и эскалация
   * «второй red на том же пункте» срабатывала по ОДНОМУ фактическому провалу, предлагая
   * поднять модель без основания.
   */
  private verdictCountedFor: string | null = null;
  private redCount = 0;
  private readonly redByCause = new Map<RedCauseKind, number>();
  /** Отработал ли независимый рецензент на ТЕКУЩЕЙ попытке. */
  private reviewerRan = false;
  /** Разобранный набор гейтов: файл проекта, читать его на каждое обращение незачем. */
  private gatesCache: { mtimeMs: number; parsed: GatesFile } | null = null;

  constructor(o: RunOptions) {
    this.config = o.config;
    this.project = o.project;
    this.profile = o.profile;
    this.slug = o.slug;
    this.gate = o.gate;
    this.askGate = o.askGate;
    this.emit = o.emit;
    this.paths = new WitokPaths(o.project.projectRoot, o.slug);
    this.mcpSetup = o.config.mcp.get(o.project.name) ?? EMPTY_MCP;
    this.hub = new McpHub(this.mcpSetup.servers);
    this.chunk = restoreChunkFromDir(this.paths.dir) ?? this.chunk;
    this.attempt = restoreAttemptFromJournal(this.paths.chunkJournal(this.chunk)) ?? this.attempt;
  }

  get ctx(): StageContext {
    return { paths: this.paths, chunk: this.chunk, attempt: this.attempt };
  }

  /**
   * Итоги последнего прогона гейтов — для интерфейса.
   *
   * Отдаётся та же таблица, по которой считается вердикт: со статусами «не скриптовых»
   * гейтов, пересчитанными по факту. Пока отдавался сырой `lastGateResults`, оператор
   * видел «⏭ Ревью независимым агентом» прямо над зелёным вердиктом — гейт, сторожащий
   * ложный зелёный, выглядел невыполненным на штатном витке.
   */
  get gateResults(): GateRunResult[] {
    return this.gateResultsForVerdict();
  }

  /**
   * Числа витка для интерфейса и пост-виток отчёта.
   *
   * Стоимость складывается так, чтобы `null` не превращался в ноль: `addUsage` уже
   * распространяет `null`, и маршрут без стоимости остаётся «без стоимости», а не «$0».
   */
  get metrics(): RunMetrics {
    return {
      stages: [...this.stageStats.entries()].map(([stage, v]) => ({
        stage,
        runs: v.runs,
        usage: v.usage,
        durationMs: v.durationMs,
      })),
      verdicts: { total: this.verdictCount, red: this.redCount },
      redByCause: [...this.redByCause.entries()].map(([kind, count]) => ({ kind, count })),
      attemptsByChunk: [...this.attemptsByChunk.entries()].map(([chunk, attempts]) => ({
        chunk,
        attempts,
      })),
      // Фильтра «показывать только там, где что-то случилось» здесь больше нет: этап,
      // не сделавший НИ ОДНОГО вызова инструмента, по прежнему условию не попадал в
      // метрики вовсе — то есть самый тяжёлый исход выглядел как отсутствие трения.
      friction: [...this.friction.entries()].map(([stage, v]) => ({ stage, ...v })),
    };
  }

  /**
   * История попыток витка — ИЗ ФАЙЛА на диске, а не из памяти процесса.
   *
   * Накопитель в памяти был вторым описанием той же истории и гарантированно расходился с
   * файлом: номер попытки виток восстанавливает с диска, а историю не восстанавливал, и
   * после перезапуска сервиса страница показывала «попытка 3» над пустой панелью, хотя
   * `iterations.md` содержал все три строки. Одна истина — файл; память остаётся только
   * запасным вариантом на случай, когда записать журнал не удалось.
   */
  get iterations(): IterationSummary[] {
    const a = readArtifact(this.paths.iterations);
    if (!a.exists) return [...this.iterationLog];
    const fromDisk = parseIterations(a.text);
    return fromDisk.length >= this.iterationLog.length ? fromDisk : [...this.iterationLog];
  }

  /** Прогон гейтов оборван отменой: набор в `gateResults` неполон. */
  get gatesAborted(): boolean {
    return this.lastGatesAborted;
  }

  get lastVerdict(): Verdict | null {
    return this.verdict;
  }

  /**
   * Дописывает строку в журнал итераций витка.
   *
   * Дописыванием, а не перезаписью: попытки в этом коде не перезаписываются нигде — по той
   * же причине, по которой не перезаписываются их патчи. Ошибка записи журнала не должна
   * ронять этап: журнал — наблюдаемость, а не условие корректности.
   */
  private recordIteration(verdict: Verdict, noProgress: boolean): void {
    try {
      const patch = readArtifact(this.paths.chunkDiff(this.chunk, this.attempt));
      const existing = readArtifact(this.paths.iterations);
      const text = appendIteration(existing.exists ? existing.text : '', {
        chunk: this.chunk,
        attempt: this.attempt,
        verdict,
        gates: this.gateResultsForVerdict(),
        patch: patch.exists ? patch.text : '',
        closeness: this.closeness,
        // Флагом, а не грепом по тексту причины: формулировка в `verdict.ts` — текст для
        // человека, и любая её правка (перенос слова, «diff» → «патч») молча выключала бы
        // признак топтания в журнале. Ровно от этого написан соседний `classify.ts`.
        noProgress,
        at: new Date(),
      });
      writeArtifact(this.paths.iterations, text);
      this.iterationLog.push({
        chunk: this.chunk,
        attempt: this.attempt,
        passed: verdict.passed,
        action: verdict.action,
        reasons: verdict.reasons,
        closeness: this.closeness,
        at: new Date().toISOString(),
      });
      this.emit({
        type: 'artifact_written',
        runId: this.id,
        stage: 'verify',
        path: this.paths.iterations,
        placeholders: 0,
      });
    } catch (e) {
      this.emit({
        type: 'warning',
        runId: this.id,
        stage: 'verify',
        message: `журнал итераций не записан: ${(e as Error).message}`,
      });
    }
  }

  /**
   * Предложение поднять модель chunk'а. Предложение, а не переход: смена модели посреди
   * витка меняет стоимость и поведение, и решает это человек.
   */
  get escalation(): Escalation {
    // КРАЙНИЕ значения ансамбля, ровно как в `checkReviewerRule`: сильнейший исполнитель
    // против слабейшего рецензента. Пока брался первый маршрут, предложение «поднять chunk
    // до X, правило рецензента сохраняется» приводило к профилю, который сам же
    // `resolveStartableProfile` отказывался стартовать — совет, ломающий запуск.
    const chunkRoutes = this.profile.ensemble.chunk ?? [this.profile.routes.chunk];
    const verifyRoutes = this.profile.ensemble.verify ?? [this.profile.routes.verify];
    const chunk = chunkRoutes.reduce((a, b) => (a.rank >= b.rank ? a : b), this.profile.routes.chunk);
    const verify = verifyRoutes.reduce((a, b) => (a.rank <= b.rank ? a : b), this.profile.routes.verify);
    return suggestEscalation({
      failedClaimsByAttempt: this.failedClaimsByAttempt,
      chunkModelId: chunk.modelId,
      chunkRank: chunk.rank,
      verifyModelId: verify.modelId,
      verifyRank: verify.rank,
      models: this.config.models.models,
    });
  }

  /** Природа красной причины и предложенный ход. `null` — вердикт зелёный или не считался. */
  get lastRedCause(): RedCause | null {
    return this.redCause;
  }

  /**
   * Записывает решение человека полем в артефакт: имя оператора и дата.
   *
   * Путь берётся не от клиента: интерфейс называет артефакт коротким именем, а рантайм
   * сам превращает его в путь внутри витка. Иначе поле решения можно было бы записать
   * в произвольный файл на диске — в том числе в чужой виток.
   */
  recordDecision(o: {
    artifact: string;
    label: string;
    /** `false` — решение отрицательное: методология требует записывать и отказ. */
    granted: boolean;
    /** Что именно решил человек. Дописывается к подписи, а не вместо неё. */
    note?: string;
    /** Chunk и попытка, к которым относится решение: клиент называет их явно. */
    chunk?: number;
    attempt?: number;
  }): string {
    if (!isArtifactKey(o.artifact)) {
      throw new Error(`неизвестный артефакт «${o.artifact}»`);
    }

    // Chunk и попытка приходят от клиента, а не берутся текущие: между показом артефакта
    // и нажатием кнопки оператор мог перейти к новой попытке, и подпись ложилась бы в
    // другой файл — тот, которого он не читал.
    const chunk = o.chunk ?? this.chunk;
    const attempt = o.attempt ?? this.attempt;

    const path = artifactPathOf(this.paths, o.artifact, chunk, attempt);
    const current = readArtifact(path);
    if (!current.exists) throw new Error(`нет артефакта ${path} — решение записывать некуда`);

    const signature = decisionValue(this.config.runner.operator, new Date());
    const note = (o.note ?? '').trim();
    // Содержательная часть решения сохраняется: `setDecision` заменяет всё после метки,
    // и без этого запись «пропуск найден: claim-4 не покрыт» стиралась подписью.
    const value = o.granted
      ? note === ''
        ? signature
        : `${signature} — ${note}`
      : `**не одобрено** — ${note === '' ? 'причина не названа' : note} · ${signature}`;

    writeArtifact(path, setDecision(current.text, o.label, value));
    this.emit({ type: 'artifact_written', runId: this.id, stage: null, path, placeholders: 0 });
    return value;
  }


  /** Каталоги вне проекта, открытые агенту только на чтение. */
  get readOnlyRoots(): string[] {
    return [
      `${this.config.runner.methodologyDir}/templates`,
      this.config.runner.methodologyDir,
      this.config.runner.skillsDir,
    ];
  }

  /**
   * Новая попытка того же chunk'а. Артефакты попытки не перезаписываются: сравнение двух
   * подряд diff'ов — единственный механический детект отсутствия прогресса, и перезапись
   * стирает его улики.
   */
  nextAttempt(): number {
    // Выжимка собирается ДО `resetAttemptState`: он обнуляет вердикт и итоги гейтов, то
    // есть ровно то, из чего она состоит. Порядок здесь значим.
    // Присваивается ВСЕГДА, в том числе `null`: если вердикт на этой попытке не считался,
    // сказать про неё нечего, а оставленная от прошлой попытки выжимка поехала бы в промпт
    // под заголовком «что не сошлось в прошлой попытке» — то есть как свежая.
    this.carryForward =
      this.lastVerdictInput === null
        ? null
        : buildRetryBrief(this.lastVerdictInput, this.lastGateResults);
    // Средовой красный не должен съедать бюджет итераций — но и переиспользовать номер
    // попытки нельзя: на момент `blocked_env` этап 5 уже отработал, и по этому номеру лежат
    // НАСТОЯЩИЕ улики (патч, запись о тестах, отчёт приёмки). Первая версия не увеличивала
    // счётчик, и следующий проход затирал их — вопреки докстрингу этого же метода.
    //
    // Поэтому номер растёт всегда, а «не занимает попытку» реализовано вычетом: бюджет
    // считается по попыткам, где работа действительно проверялась.
    if (this.verdict?.action === 'blocked_env') this.envBlockedAttempts += 1;
    this.attempt += 1;
    this.resetAttemptState();
    this.notePeakAttempt();
    return this.attempt;
  }

  /** Следующий chunk витка: нумерация попыток начинается заново. */
  nextChunk(): number {
    this.chunk += 1;
    this.attempt = 1;
    this.envBlockedAttempts = 0;
    // Новый chunk — другая работа: причины красного по прошлому к нему не относятся.
    this.carryForward = null;
    this.failedClaimsByAttempt = [];
    this.resetAttemptState();
    this.notePeakAttempt();
    return this.chunk;
  }

  /**
   * Отмечает достигнутый номер попытки для метрик.
   *
   * Зовётся при СМЕНЕ попытки, а не при расчёте вердикта: пока счёт вёлся только внутри
   * `computeStageVerdict`, попытки, оборванные на этапе 5 или отменённые до verify, в
   * метрики и в пост-виток отчёт не попадали вовсе — то есть отчёт «что съело итерации»
   * занижал ровно то число, ради которого его и завели.
   */
  private notePeakAttempt(): void {
    this.attemptsByChunk.set(
      this.chunk,
      Math.max(this.attemptsByChunk.get(this.chunk) ?? 0, this.attempt),
    );
  }

  /**
   * Состояние, принадлежащее попытке, а не витку.
   *
   * Без сброса `GET /api/runs/:id` после «новой попытки» отдавал гейты и вердикт
   * ПРЕДЫДУЩЕЙ как текущие, и интерфейс рисовал зелёный вердикт рядом с номером попытки,
   * которая ещё не запускалась.
   */
  private resetAttemptState(): void {
    this.lastGateResults = [];
    this.lastGatesAborted = false;
    this.verdict = null;
    this.lastVerdictInput = null;
    this.redCause = null;
    this.reviewerRan = false;
    // Близость к прошлому патчу — свойство ПОПЫТКИ. Пока её тут не было, шапка новой
    // попытки до самого вердикта показывала совпадение от предыдущей, то есть янтарным
    // предупреждала о топтании там, где ещё ничего не сделано.
    this.closeness = null;
    // Вердикт этой попытки ещё не считался — счётчики статистики не должны его удвоить
    // при повторном запуске verify (правка набора гейтов и второй прогон — обычное дело).
    this.verdictCountedFor = null;
  }

  /** Набор гейтов проекта. `null` — файла нет. */
  get gatesFile(): GatesFile | null {
    // Кэш по времени правки: один `GET /api/runs/:id` спрашивал набор семь раз (по разу
    // на этап в `blockers` плюс бюджет попыток), и каждый раз это было чтение файла и
    // полный разбор всех его таблиц — синхронно, в том же цикле событий, что и поток
    // WebSocket. Набор — файл проекта: он меняется раз в месяцы, а не раз в запрос.
    let mtimeMs: number;
    try {
      mtimeMs = statSync(this.paths.gates).mtimeMs;
    } catch {
      this.gatesCache = null;
      return null;
    }

    if (this.gatesCache?.mtimeMs === mtimeMs) return this.gatesCache.parsed;

    const a = readArtifact(this.paths.gates);
    if (!a.exists) {
      this.gatesCache = null;
      return null;
    }
    const parsed = parseGates(a.text);
    this.gatesCache = { mtimeMs, parsed };
    return parsed;
  }

  /** Бюджет попыток из набора гейтов, умолчание методологии — 3. */
  get attemptBudget(): number {
    const DEFAULT = 3;
    const row = this.gatesFile?.rows.find((r) => /бюджет итераций/i.test(r.name));

    // Число берётся ТОЛЬКО у включённой строки. Пока читалась любая, проза выключенной
    // («н/п — долг, скрипт tools/budget2.py») давала бюджет 2, а «вернуться в Q2 2027» —
    // свой мусор: оператор видел «попытка 1 из 2027», и эскалация не наступала никогда.
    if (row === undefined || !row.enabled) return DEFAULT;

    const m = /(\d+)/.exec(row.implementation);
    const parsed = m === null ? NaN : Number(m[1]);
    if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT;

    // Потолок: бюджет — это число попыток человека, а не год из фразы.
    return Math.min(parsed, 20);
  }

  /**
   * Список файлов, в которые разрешена запись, либо `null` — PlanScope выключен.
   *
   * Пустой список при существующем плане — не «разрешено всё», а дефект: так PlanScope
   * выключился бы молча. Такой виток не продолжается (см. `blockers`).
   */
  planFilesFor(stage: StageId): readonly string[] | null {
    if (!PLAN_SCOPED_STAGES.includes(stage)) return null;
    const plan = readArtifact(this.paths.plan);
    if (!plan.exists) return null;
    return extractFilesToTouch(plan.text);
  }

  policyContext(stage: StageId): PolicyContext {
    const def = stageById(stage);
    return {
      projectRoot: this.project.projectRoot,
      stage,
      sdlcDir: `.sdlc/${this.slug}`,
      planFiles: this.planFilesFor(stage),
      protectedArtifacts: def.protectedArtifacts(this.ctx),
      readOnlyRoots: this.readOnlyRoots,
      allowedTools: this.toolsFor(stage),
      mcpTools: rulesForStage(this.mcpSetup, stage),
    };
  }

  /**
   * Права этапа плюс права на MCP, если оператор выдал этому этапу инструменты.
   *
   * Само определение этапа про MCP не знает и знать не должно: набор инструментов задаётся
   * конфигом ПРОЕКТА, а `stages.ts` общий для всех. Поймано живым прогоном: инструменты
   * модели выдавались, вызов доходил до политики и отклонялся ею — «читающие вызовы MCP не
   * разрешены на этапе», потому что права не выдавал никто.
   */
  private toolsFor(stage: StageId): readonly ToolName[] {
    const base = stageById(stage).tools;
    const rules = rulesForStage(this.mcpSetup, stage);
    if (rules.length === 0) return base;

    const extra: ToolName[] = [];
    if (rules.some((r) => effectiveMode(r) === 'read')) extra.push('McpRead');
    if (rules.some((r) => effectiveMode(r) === 'write')) extra.push('McpWrite');
    return [...base, ...extra];
  }

  /**
   * Счётчик строки трения. Один на все шесть полей.
   *
   * Вызовы инструментов и напоминания стража — не трение, а фон, на котором трение
   * читается: «ноль вызовов за пятнадцать минут» и «два напоминания и пустой артефакт» —
   * это то, что оператор ищет в постмортеме первым. Раньше их считал отдельный метод с
   * дословно тем же телом; двух одинаковых счётчиков не бывает долго — правка попадает
   * в один и забывается в другом.
   */
  private countFriction(stage: StageId, kind: FrictionKind | 'toolCalls'): void {
    const cur = this.friction.get(stage) ?? EMPTY_FRICTION();
    // `reminder` в событии — единственное число в таблице; поле названо во множественном
    // («сколько напоминаний»), и переименовывать его в контракте ради совпадения с именем
    // события значило бы сломать чтение метрик у клиента.
    const field = kind === 'reminder' ? 'reminders' : kind;
    cur[field] += 1;
    this.friction.set(stage, cur);
  }

  /**
   * Внешние MCP-серверы, выданные этапу: соединения, отбор набора, исполнение вызова.
   *
   * Соединения поднимаются здесь — лениво, на этап. Недоступный сервер этап НЕ роняет:
   * его инструменты просто не попадают в набор, а причина уходит оператору и в промпт.
   * Иначе выключенный редактор превращался бы в непонятный отказ посреди работы.
   */
  private async mcpAccess(stage: StageId): Promise<McpAccess | null> {
    const rules = rulesForStage(this.mcpSetup, stage);
    this.mcpSelected = [];
    if (rules.length === 0 || this.hub.size === 0) return null;

    const servers = [...new Set(rules.map((r) => r.server))];
    const failed = await this.hub.ensureReady(servers);

    for (const name of servers) {
      const s = this.hub.status(name);
      this.emit({
        type: 'mcp_state',
        runId: this.id,
        stage,
        server: name,
        state: s.state,
        reason: s.reason,
        toolCount: s.toolCount,
      });
    }
    for (const name of failed) {
      this.emit({
        type: 'warning',
        runId: this.id,
        stage,
        message:
          `MCP-сервер «${name}» недоступен: ` +
          `${this.hub.status(name).reason ?? 'причина не названа'}`,
      });
    }

    const selection = selectTools(rules, this.hub.tools(servers), this.mcpSetup.maxInlineTools);
    this.mcpSelected = selection.tools;

    // Отброшенное называется вслух: молча укороченный набор читается как «дали всё».
    for (const d of selection.dropped) {
      this.emit({
        type: 'warning',
        runId: this.id,
        stage,
        message: `MCP-инструмент ${d.name} не выдан: ${d.why}`,
      });
    }

    if (selection.tools.length === 0) return null;

    const sdkServers: Record<string, unknown> = {};
    for (const spec of this.mcpSetup.servers) {
      if (!servers.includes(spec.name)) continue;
      sdkServers[spec.name] =
        spec.transport === 'http'
          ? { type: 'http', url: spec.url, headers: spec.headers }
          : { type: 'stdio', command: spec.command, args: spec.args, env: spec.env };
    }

    const maxBytes = Math.min(
      this.mcpSetup.maxResultBytes,
      this.config.runner.limits.maxToolResultBytes,
    );

    return {
      tools: selection.tools.map((t) => ({
        name: t.name,
        description: t.description,
        schema: t.schema,
      })),
      sdkServers,
      pollingTools: servers.flatMap((n) => this.hub.pollingPatterns(n)),
      call: async (server, tool, args, signal) => {
        const outcome = await this.hub.call(server, tool, args, {
          signal,
          fold: {
            saveImage: imageSaver(() =>
              join(this.paths.dir, 'mcp', `${stage}-${this.chunk}-${++this.mcpImageSeq}`),
            ),
          },
        });
        return { ok: outcome.ok, text: cap(outcome.text, maxBytes) };
      },
    };
  }

  /** Недоступные серверы витка с причинами — для честной строки в промпте. */
  private mcpUnavailable(): { name: string; reason: string }[] {
    return this.hub
      .names()
      .map((name) => ({ name, status: this.hub.status(name) }))
      .filter((x) => x.status.state === 'unavailable')
      .map((x) => ({ name: x.name, reason: x.status.reason ?? 'причина не названа' }));
  }

  /** Набор MCP-инструментов последнего запуска этапа и его цена — для интерфейса. */
  mcpStageInfo(): { tools: string[]; estimatedTokens: number } {
    return {
      tools: this.mcpSelected.map((t) => t.name),
      estimatedTokens: estimateTokens(this.mcpSelected),
    };
  }

  /** Состояние серверов для панели оператора. */
  mcpServers(): McpServerInfo[] {
    const selected = new Map<string, string[]>();
    for (const t of this.mcpSelected) {
      const list = selected.get(t.server) ?? [];
      list.push(t.tool);
      selected.set(t.server, list);
    }
    return this.hub.info(selected);
  }

  /**
   * Дополнительные маршруты ансамбля рецензентов. Только этап 6 и только он.
   *
   * Ансамбль на пишущем этапе — это второй исполнитель, который правит те же файлы поверх
   * готового патча первого: улика попытки становится смесью двух авторов, а детект
   * отсутствия прогресса сравнивает патчи, собранные разным числом рук. Поэтому ограничение
   * стоит здесь, в рантайме, а не держится на том, что так никто не сконфигурирует.
   *
   * Каждый маршрут пишет в канонический путь отчёта (его называет промпт этапа), а рантайм
   * сразу переносит написанное в путь маршрута. Так вердикт получает ВСЕ мнения, а не
   * последнее записанное, и при этом ни промпт, ни имя основного артефакта не меняются.
   */
  private async runEnsembleReviewers(
    prompt: PreparedPrompt,
    def: StageDef,
    agents: readonly SubagentDef[],
    hooks: ExecHooks,
  ): Promise<void> {
    const extraRoutes = (this.profile.ensemble.verify ?? []).slice(1);
    const aborter = this.aborter;
    if (extraRoutes.length === 0 || aborter === null) return;

    const canonical = this.paths.verificationReport(this.chunk, this.attempt, 0);
    const primary = readArtifact(canonical).text;

    for (const [i, other] of extraRoutes.entries()) {
      if (this.aborter?.signal.aborted === true) break;
      const route = i + 1;
      this.emit({
        type: 'warning',
        runId: this.id,
        stage: 'verify',
        message: `ансамбль: дополнительный маршрут ${route + 1} — ${other.modelId}`,
      });

      // Канонический файл убирается, чтобы следующий рецензент не дописывал в чужой отчёт
      // и не выдавал его за свой.
      writeArtifact(canonical, '');
      try {
        await this.executorFor('verify', other).run(
          {
            prompt,
            cwd: this.project.projectRoot,
            model: other.model,
            allowedTools: this.toolsFor('verify'),
            // Тот же набор, что у первого маршрута: соединения уже подняты, отбор посчитан.
            mcp: await this.mcpAccess('verify'),
            // Стража нет: канонический файл отчёта здесь намеренно опустошён перед каждым
            // маршрутом ансамбля, и «артефакт на месте» тут не признак сделанной работы.
            finishGuard: null,
        // Субагент артефактов этапа не производит — спасать нечего.
        salvageFromText: null,
            readOnlyDirs: this.readOnlyRoots,
            subagents: agents,
            maxTurns: this.config.runner.limits.maxIterationsPerStage,
            maxBudgetUsd: this.project.maxBudgetUsd,
            spentUsdBefore: this.totalUsage.costUsd ?? 0,
            signal: aborter.signal,
          },
          hooks,
        );
      } catch (e) {
        // Падение ДОПОЛНИТЕЛЬНОГО рецензента не отменяет вердикт по уже готовым отчётам:
        // пока оно улетало в общий catch этапа, работа основного маршрута выбрасывалась
        // целиком и оператор возвращался к попытке с нуля.
        this.emit({
          type: 'warning',
          runId: this.id,
          stage: 'verify',
          message:
            `ансамбль: маршрут ${route + 1} (${other.modelId}) не отработал: ` +
            `${(e as Error).message}. Вердикт считается по отчётам остальных.`,
        });
      }
      writeArtifact(this.paths.verificationReport(this.chunk, this.attempt, route), readArtifact(canonical).text);
    }

    // Канонический путь возвращается основному маршруту: его читают скиллы `/sdlc-*`,
    // предусловия этапов и витки, начатые в терминале.
    writeArtifact(canonical, primary);
  }

  private executorFor(stage: StageId, forRoute?: ResolvedRoute): StageExecutor {
    const route = forRoute ?? this.profile.routes[stage];
    if (route.flow === 'sdk') return new SdkExecutor();

    const limits = this.config.runner.limits;
    return new LoopExecutor({
      provider: createProvider(route.provider, route.providerDef, limits.chatTimeoutMs),
      // Свой потолок у локального контура: общий рассчитан на большое окно, а здесь один
      // `Read` по нему забирал почти весь контекст 16K — измерено на прогоне.
      maxResultBytes: Math.min(limits.maxToolResultBytes, limits.localMaxToolResultBytes),
      readRangeRequiredAboveBytes: limits.readRangeRequiredAboveBytes,
      bashTimeoutMs: limits.gateTimeoutMs,
      // Температуру не задаём: у части серверов «не задано» и «0» ведут себя по-разному,
      // и подставлять своё значение молча — значит менять поведение модели за оператора.
      temperature: null,
    });
  }

  /**
   * Готовит промпт этапа, не запуская его. Отдельный шаг, потому что оператор вправе
   * отредактировать промпт до отправки — а значит, он должен увидеть его раньше.
   */
  preparePrompt(stage: StageId, opts: { requirement?: string; extra?: string } = {}): PreparedPrompt {
    // Диагноз прошлой попытки попадает уже в собранный промпт, а не подклеивается позже:
    // промпт уходит в шину и редактируется оператором, и всё, что уйдёт в модель, должно
    // быть видно ему до запуска. Проверка на вхождение — от второго экземпляра, когда
    // `runStage` уже подмешал тот же блок в `extra`.
    if (
      stage === 'chunk' &&
      this.carryForward !== null &&
      !(opts.extra ?? '').includes(this.carryForward)
    ) {
      const carried = this.carryForward;
      opts = {
        ...opts,
        extra: opts.extra === undefined ? carried : `${opts.extra}\n\n${carried}`,
      };
    }

    const def = stageById(stage);
    const route = this.profile.routes[stage];
    const ecosystem = describeBuild({
      projectRoot: this.project.projectRoot,
      planFiles: this.planFilesFor(stage) ?? [],
      baseline: null,
      timeoutMs: this.config.runner.limits.gateTimeoutMs,
      ...(this.project.modules === undefined ? {} : { modules: this.project.modules }),
    });
    const prompt = buildPrompt({
      runner: this.config.runner,
      stage: def,
      ctx: this.ctx,
      flow: route.flow,
      slug: this.slug,
      now: new Date(),
      ...(opts.requirement === undefined ? {} : { requirement: opts.requirement }),
      ...(opts.extra === undefined ? {} : { extra: opts.extra }),
      // Чем проект собирается — тем же источником, что у гейтов. Пусто (плана ещё нет,
      // экосистема не определилась) — блок в промпте молчит, а не гадает.
      ...(ecosystem.length === 0 ? {} : { ecosystem }),
      // Набор MCP-инструментов и состояние серверов: считаются до сборки промпта, чтобы
      // панель промпта показывала ровно то, что уходит в модель.
      ...(this.mcpSelected.length === 0 ? {} : { mcpTools: this.mcpSelected }),
      ...(this.mcpUnavailable().length === 0 ? {} : { mcpUnavailable: this.mcpUnavailable() }),
      ...(this.seeded.length === 0 ? {} : { seededArtifacts: this.seeded }),
    });
    this.emit({ type: 'prompt_prepared', runId: this.id, stage, prompt });
    return prompt;
  }

  /**
   * Причины, по которым этап не начинается. Пустой массив — можно стартовать.
   *
   * `precomputed` передаётся, когда предусловия уже посчитаны вызывающим: `runStage`
   * считал их дважды подряд ради одного и того же ответа.
   */
  blockers(
    stage: StageId,
    opts: { abortHandoff?: boolean } = {},
    precomputed?: PreconditionReport,
  ): string[] {
    const report = precomputed ?? checkPreconditions(stageById(stage), this.ctx, opts);
    const problems = [...report.problems];

    if (PLAN_SCOPED_STAGES.includes(stage)) {
      const files = this.planFilesFor(stage);
      if (files !== null && files.length === 0) {
        problems.push(
          `план ${this.paths.plan} есть, но files_to_touch пуст: PlanScope выключился бы молча, ` +
            `и запись перестала бы быть ограниченной планом. Заполни секцию files_to_touch.`,
        );
      }
    }

    // Обязательная пятёрка проверяется на старте КАЖДОГО этапа, кроме первого: именно
    // на первом набор и собирают. Проверять её только на этапе 6 значило бы узнавать
    // о несобранном наборе, потратив весь виток.
    //
    // Объявленный обрыв витка из-под этой проверки выведен намеренно: handoff при обрыве —
    // единственный способ оставить запись о том, почему виток бросили, и запирать его
    // тем же несобранным набором значило бы лишить виток последнего легального выхода.
    if (stage !== 'intent' && !(stage === 'handoff' && opts.abortHandoff === true)) {
      const gates = this.gatesFile;
      if (gates === null) {
        problems.push(
          `нет набора гейтов ${this.paths.gates}. Без него не определены ни «сделано», ни ` +
            `условия вердикта — виток не стартует.`,
        );
      } else {
        problems.push(...configProblems(gates));
        // `REVIEW_GATE` не в BUILTIN и не в кавычках, но НЕ является дырой в наборе: он
        // получает статус не скриптом gates/run.ts, а `externalGateStatuses()` ниже — тем
        // же путём, каким и реально считается на прогоне (см. `runGates({ externalStatuses:
        // this.externalGateStatuses() })`). Без этого исключения витки с обычным для
        // минимума набором никогда бы не проходили дальше intent.
        problems.push(...unimplementedGates(gates, (name) => builtinFor(name) !== null, [REVIEW_GATE]));
      }
    }

    // Последний ИЗВЕСТНЫЙ (не обязательно свежий — см. `lastPreflightBlockers`)
    // pre-flight-статус песочницы: без этого GET-ручки, которые как раз для того и зовут
    // `blockers()`, чтобы показать оператору «почему этап нельзя начать» ДО клика «Старт»,
    // никогда не видели провал пробы среды — он всплывал только ошибкой уже начавшегося
    // `runStage`. Отдельная ветка от `preflightBlockers` (не встроена в неё саму) — та
    // асинхронна (ходит в Docker), а `blockers()` обязан остаться синхронным: он вызывается
    // на каждый опрос списка витков, и дёргать Docker на каждый такой опрос было бы дороже
    // самой проблемы, которую чинит.
    if (stage === 'verify') {
      problems.push(...this.lastPreflightBlockers);
    }

    return problems;
  }

  /**
   * Прогон автоматических гейтов этапа 6.
   *
   * Порядок из методологии: автоматические гейты идут ПЕРЕД ревью, а не держатся на
   * промпте рецензента — поэтому это шаг рантайма, который модель не может пропустить.
   * Результаты уходят в шину по одному, чтобы длинная сборка была видна по ходу, а не
   * появлялась разом в конце.
   */
  async runVerifyGates(signal?: AbortSignal): Promise<GateRunResult[]> {
    const gates = this.gatesFile;
    if (gates === null) return [];

    // Итоги копятся по одному, а не присваиваются разом в конце: интерфейс перечитывает
    // состояние по событию `gate_result`, и при позднем присваивании каждый такой запрос
    // возвращал таблицу ПРЕДЫДУЩЕГО прогона — зелёную, пока текущий уже краснел.
    this.lastGateResults = [];
    this.lastGatesAborted = false;

    const results = await runGates({
      gates,
      projectRoot: this.project.projectRoot,
      projectName: this.project.name,
      planFiles: this.planFilesFor('verify') ?? [],
      baseline: this.readBaseline(),
      timeoutMs: this.config.runner.limits.gateTimeoutMs,
      // Описание модулей проекта: человек знает про свой моно-репо больше, чем детект.
      ...(this.project.modules === undefined ? {} : { modules: this.project.modules }),
      ...(signal === undefined ? {} : { signal }),
      externalStatuses: this.externalGateStatuses(),
      onWarn: (message) => this.emit({ type: 'warning', runId: this.id, stage: 'verify', message }),
      onResult: (gate) => {
        this.lastGateResults.push(gate);
        this.emit({ type: 'gate_result', runId: this.id, stage: 'verify', gate });
      },
    });

    // Отмена прерывает цикл гейтов и возвращает то, что успело прогнаться. Без этой
    // отметки частичный набор выглядел в интерфейсе полным: две зелёные строки читались
    // как «весь набор пройден», хотя обязательная пятёрка не запускалась.
    this.lastGatesAborted = signal?.aborted === true;
    this.lastGateResults = results;
    return results;
  }

  /**
   * Принять содержимое артефакта, напечатанное в ответ вместо вызова инструмента.
   *
   * Три вещи, которые здесь важнее самой возможности:
   *
   *  1. Запись идёт **через гейт одобрения**, как любая другая: рантайм не доверяет тексту,
   *     он предлагает оператору вызов, который тот видит и может отклонить.
   *  2. Пишутся только файлы из `produces` этого этапа — не «всё, что похоже на файл».
   *  3. Вызывается только когда страж уже сказал, что артефакт пуст: это спасение хода,
   *     а не второй, тихий способ записи в обход инструментов.
   */
  private async salvageFromText(
    text: string,
    produced: readonly string[],
    stage: StageId,
  ): Promise<string | null> {
    const blocks = salvageBlocks(text, produced);
    if (blocks.length === 0) return null;

    const written: string[] = [];
    for (const b of blocks) {
      const call: NormalizedCall = { kind: 'write', path: b.path, content: b.content };
      const decision = await this.gate.request({
        runId: this.id,
        stage,
        requestId: `salvage-${this.salvageSeq++}`,
        toolName: 'Write',
        rawInput: { file_path: b.path, content: b.content },
        call,
        ctx: this.policyContext(stage),
      });
      if (!decision.allowed) continue;
      // Правка оператора применяется, как на любом другом пути записи: он открыл карточку,
      // исправил содержимое и одобрил ИСПРАВЛЕННОЕ. Игнорировать `updatedInput` здесь
      // значило бы записать на диск не то, что он подтвердил, — при том что сообщение в
      // журнал утверждает «записано через гейт одобрения».
      const edited = (decision.updatedInput as Record<string, unknown> | null)?.['content'];
      const content = typeof edited === 'string' ? edited : b.content;
      writeArtifact(b.path, content);
      written.push(b.path);
    }

    if (written.length === 0) return null;
    return (
      `содержимое артефакта было напечатано в ответ, а не записано инструментом — ` +
      `рантайм записал его через гейт одобрения: ${written.join(', ')}`
    );
  }

  /**
   * Патч и запись о тестах этой попытки — из фактов, а не из слов исполнителя.
   *
   * Тесты гоняются ТОЙ ЖЕ строкой набора, что и на этапе 6, через `runGateByName`: два
   * способа «запустить тесты проекта» расходятся молча, и они уже разошлись — проект с
   * `./gradlew test` в наборе получал в улике результат встроенного автодетекта.
   *
   * Возвращает, что стало с деревом. `unknown` — посчитать не удалось; вызывающий обязан
   * обойтись с этим как с провалом, а не как с «правки были».
   */
  private async recordEvidence(diffBefore: string): Promise<TreeChange> {
    const gateCtx: GateContext = {
      projectRoot: this.project.projectRoot,
      planFiles: this.planFilesFor('chunk') ?? [],
      baseline: this.readBaseline(),
      timeoutMs: this.config.runner.limits.gateTimeoutMs,
      ...(this.project.modules === undefined ? {} : { modules: this.project.modules }),
      ...(this.aborter === null ? {} : { signal: this.aborter.signal }),
    };

    // Гейт «Тесты» берётся из НАБОРА проекта, а не из реестра встроенных: приоритет
    // команды в обратных кавычках — правило `runOne`, и улика обязана его соблюдать.
    const gates = this.gatesFile;
    const runTests: BuiltinGate | null =
      gates === null
        ? null
        : async (c: GateContext) => {
            const r = await runGateByName('Тесты', {
              gates,
              projectRoot: this.project.projectRoot,
              projectName: this.project.name,
              planFiles: c.planFiles,
              baseline: c.baseline,
              timeoutMs: c.timeoutMs,
              ...(this.project.modules === undefined ? {} : { modules: this.project.modules }),
              ...(c.signal === undefined ? {} : { signal: c.signal }),
            }, c);
            if (r === null) {
              return {
                status: '⏭',
                command: null,
                exitCode: null,
                lastLine: 'строки «Тесты» в наборе нет или она выключена — прогон не назначен',
              };
            }
            return {
              status: r.status,
              command: r.command,
              exitCode: r.exitCode,
              lastLine: r.lastLine,
              envBlocked: r.envBlocked,
            };
          };

    try {
      const { tree, testsNote } = await recordAttemptEvidence({
        projectRoot: this.project.projectRoot,
        diffPath: this.paths.chunkDiff(this.chunk, this.attempt),
        testsPath: this.paths.chunkTests(this.chunk, this.attempt),
        diffBefore,
        gateCtx,
        runTests,
        ...(this.aborter === null ? {} : { signal: this.aborter.signal }),
      });

      // Пустой патч называется вслух: «этап закончился, артефакты на месте» при нетронутом
      // дереве — тот самый правдоподобный успех, ради которого улики и отобраны у агента.
      if (tree === 'empty') {
        this.emit({
          type: 'warning',
          runId: this.id,
          stage: 'chunk',
          message: 'дерево не изменилось за эту попытку — правки не было',
        });
      }
      this.emit({
        type: 'warning',
        runId: this.id,
        stage: 'chunk',
        message: `свидетельства попытки перезаписаны рантаймом · тесты: ${testsNote}`,
      });
      return tree;
    } catch (e) {
      this.emit({
        type: 'warning',
        runId: this.id,
        stage: 'chunk',
        message: `не удалось записать свидетельства попытки: ${(e as Error).message}`,
      });
      return 'unknown';
    }
  }

  /**
   * Статусы гейтов, которые рантайм не исполняет скриптом.
   *
   * «Ревью независимым агентом» — единственный такой в минимальной пятёрке, и зелёный он
   * получает ТОЛЬКО по факту состоявшегося прогона субагента-рецензента на этой попытке.
   *
   * Раньше статус выводился из наличия файла `sdlc-reviewer.md` на диске и вычислялся до
   * запуска исполнителя. На профиле `local` это давало ложный зелёный на каждом витке:
   * субагенты во флоу `loop` не запускаются вовсе, а определение лежит в каталоге — и
   * гейт, ради которого построен принцип «автор не рецензирует себя», отчитывался `✅`
   * при полном отсутствии ревью.
   */
  private externalGateStatuses(): Record<string, GateStatus> {
    const { missing } = loadSubagents(this.config.runner.agentsDir, REVIEWER_AGENTS);

    const status: GateStatus =
      missing.length === REVIEWER_AGENTS.length
        ? '⏭' // ни одного определения субагента нет — рецензировать некому
        : this.reviewerRan
          ? '✅'
          : '⏭'; // прогона ещё не было либо субагент не вызывался

    return { [gateKey(REVIEW_GATE)]: status };
  }

  /**
   * Отмечает, что независимый рецензент отработал на этой попытке.
   *
   * Ставится исполнителем при фактическом вызове субагента, а не наличием файла: это
   * единственный факт, по которому гейт минимума может стать зелёным.
   */
  markReviewerRan(): void {
    this.reviewerRan = true;
  }

  /** Итоги прогона с пересчитанными статусами «не скриптовых» гейтов. */
  private gateResultsForVerdict(): GateRunResult[] {
    const external = this.externalGateStatuses();
    return this.lastGateResults.map((r) => {
      const fresh = external[gateKey(r.name)];
      if (fresh === undefined || fresh === r.status) return r;
      return {
        ...r,
        status: fresh,
        lastLine:
          fresh === '✅'
            ? 'независимый рецензент отработал на этой попытке'
            : 'независимый рецензент на этой попытке не запускался',
      };
    });
  }

  /**
   * Вердикт этапа 6 по отчёту приёмки и фактическому прогону гейтов.
   *
   * Считается кодом, а не моделью: слабый рецензент может ошибиться в статусе, но
   * ложный зелёный выдать не может.
   */
  computeStageVerdict(noProgress = false): Verdict | null {
    const gates = this.gatesFile;
    if (gates === null) return null;

    // Отчёты ВСЕХ маршрутов ансамбля, а не один канонический: свод по худшему статусу
    // делает «`✅` только если так сказали все» свойством вердикта. Раньше все рецензенты
    // писали в один файл, и в вердикт попадало мнение записавшего последним.
    const routeCount = Math.max(1, (this.profile.ensemble.verify ?? []).length);
    const reports = Array.from({ length: routeCount }, (_, r) =>
      readArtifact(this.paths.verificationReport(this.chunk, this.attempt, r)).text,
    ).filter((t) => t.trim() !== '');

    const { input, disagreements } = collectVerdictInput({
      gates,
      // Статусы гейтов, которые рантайм не исполняет скриптом, пересчитываются здесь:
      // прогон идёт ДО ревью, и на его момент рецензент заведомо не отработал. Без
      // пересчёта гейт ревью навсегда оставался бы `⏭` даже после честного прогона.
      gateResults: this.gateResultsForVerdict(),
      // Факт запуска рецензента рантайм знает достовернее отчёта: `⏭` («не запускался»)
      // в отчёте не может опровергнуть состоявшийся вызов субагента. Красный отчёта при
      // этом всё равно побеждает — см. `collectVerdictInput`.
      runtimeAuthoritativeWhenGreen: [gateKey(REVIEW_GATE)],
      // Ручные пункты приходят из ЗАДАЧИ, а не из отчёта: освобождение от автоматической
      // проверки — решение человека, написавшего приёмочный лист.
      manualClaims: manualClaimIds(readArtifact(this.paths.intent).text),
      reports,
      // Попытки, сгоревшие на среде, из счёта вычитаются: бюджет итераций тратится на
      // работу, а не на машину. Номер попытки при этом растёт всегда — см. nextAttempt.
      attempt: Math.max(1, this.attempt - this.envBlockedAttempts),
      attemptBudget: this.attemptBudget,
      noProgress,
    });

    const verdict = computeVerdict(input, disagreements);
    // Расхождение отчёта с прогоном не роняет вердикт само по себе (в статус уже взят
    // худший из двух), но обязано быть видно: рецензент, переписывающий статусы, —
    // отдельный симптом, о котором оператор должен узнать.
    // Близость называется фактом рядом с причинами — и ТОЛЬКО у красного: у зелёного
    // вопроса «топчемся ли» нет. `passed` при этом не пересчитывается по длине `reasons`,
    // иначе приписка сама делала бы вердикт красным.
    const closenessNote =
      !verdict.passed &&
      this.closeness !== null &&
      this.closeness >= this.config.runner.limits.progressClosenessWarn
        ? [
            `патч этой попытки совпадает с предыдущей на ${Math.round(this.closeness * 100)}% ` +
              `по существу (порог ${Math.round(
                this.config.runner.limits.progressClosenessWarn * 100,
              )}%) — похоже на топтание на месте; решение о переходе принимает человек`,
          ]
        : [];

    // Пометка о некалиброванных гейтах: красный, полученный проверкой, чью способность
    // ловить никто не подтверждал посевом, стоит читать с оговоркой. На `passed` это не
    // влияет — иначе один флаг в наборе гейтов начал бы решать судьбу витка.
    // Показывается при ЛЮБОМ исходе, а не только при красном: текст говорит «„зелёный“ от
    // них слабее, чем выглядит», то есть адресован ровно тому случаю, когда вердикт
    // зелёный и человек собирается принимать работу. Условие `!passed` выключало
    // предупреждение в единственной ситуации, ради которой оно написано.
    // Ветка `gates === null` тут мёртвая — до неё функция уже вышла.
    const uncalibrated = uncalibratedGates(gates);
    const calibrationNote =
      uncalibrated.length > 0
        ? [
            `посевом не проверялись гейты: ${uncalibrated.join(', ')} — их способность ` +
              'ловить дефекты не подтверждена, и «зелёный» от них слабее, чем выглядит',
          ]
        : [];

    const notes = [...disagreements, ...closenessNote, ...calibrationNote];
    const withNotes: Verdict =
      notes.length === 0 ? verdict : { ...verdict, reasons: [...verdict.reasons, ...notes] };

    this.verdict = withNotes;
    this.lastVerdictInput = input;
    // Классификация считается только по красному: у зелёного «куда возвращать» нет вопроса.
    this.redCause = withNotes.passed ? null : classifyRedVerdict(input, disagreements);

    // Статистика попытки учитывается РОВНО ОДИН РАЗ. Пересчёт вердикта на той же попытке
    // (оператор поправил набор гейтов и запустил verify снова) обязан обновить сам
    // вердикт, но не удваивать историю: иначе одна неудача выглядит как две.
    const key = `${this.chunk}:${this.attempt}`;
    if (this.verdictCountedFor !== key) {
      this.verdictCountedFor = key;
      this.recordIteration(withNotes, noProgress);
      this.verdictCount += 1;
      if (!withNotes.passed) this.redCount += 1;
      if (this.redCause !== null) {
        this.redByCause.set(this.redCause.kind, (this.redByCause.get(this.redCause.kind) ?? 0) + 1);
      }
      // `manual` сюда не идёт: пункт, освобождённый человеком от автоматической проверки,
      // «не закрывается вторую попытку подряд» по построению, и предложение поднять модель
      // из-за него — совет лечить то, что не болеет.
      this.failedClaimsByAttempt.push(
        input.claims.filter((c) => c.status !== '✅' && c.status !== 'manual').map((c) => c.id),
      );
    }
    this.emit({ type: 'verdict', runId: this.id, stage: 'verify', verdict: withNotes });
    return withNotes;
  }

  private readBaseline(): ReadonlyMap<string, string> | null {
    const a = readArtifact(this.paths.chunkBaseline(this.chunk));
    if (!a.exists) return null;
    try {
      return new Map(Object.entries(JSON.parse(a.text) as Record<string, string>));
    } catch {
      return null;
    }
  }

  /**
   * Снимок грязного дерева перед первой попыткой chunk'а.
   *
   * Без него scope-гейт вменяет исполнителю чужие незакоммиченные правки оператора.
   * Снимается один раз на chunk: на второй попытке дерево уже содержит работу агента,
   * и пересъёмка стёрла бы ровно то, что гейт должен увидеть.
   */
  private async ensureBaseline(): Promise<void> {
    const path = this.paths.chunkBaseline(this.chunk);
    if (readArtifact(path).exists) return;
    const snapshot = await snapshotBaseline(this.project.projectRoot);
    writeArtifact(path, JSON.stringify(snapshot, null, 2));

    // Грязное дерево называется человеку. Методология (этап 5): «дерево грязное чужими
    // правками — назови их человеку одной строкой… молча продолжать нельзя, эти файлы
    // попадут в diff попытки и в гейт „Scope: файлы вне плана“ как твоя работа». База
    // отличит чужое от своего, но оператор должен знать, что она вообще понадобилась.
    const dirty = Object.keys(snapshot);
    if (dirty.length === 0) return;
    const shown = dirty.slice(0, 5).join(', ');
    this.emit({
      type: 'warning',
      runId: this.id,
      stage: 'chunk',
      message:
        `дерево грязное до начала chunk'а: ${dirty.length} файл(ов) — ${shown}` +
        `${dirty.length > 5 ? ` и ещё ${dirty.length - 5}` : ''}. Их правки в diff попытки ` +
        `не войдут: база chunk ${this.chunk} записана. Решение — чинить дерево или ` +
        `продолжать с базой — за вами.`,
    });
  }

  /**
   * Блокер, если рабочее дерево стоит не на ветке, объявленной задачей.
   *
   * `null` — либо ветка совпадает, либо проверять не с чем: не git-репозиторий, поле
   * «Ветка витка» не заполнено или в нём плейсхолдер (`intent.md` этого не требует —
   * поле по форме опционально текстом-подсказкой «‹sdlc/слаг или по конвенции проекта›»,
   * и виток без него не бракуется, просто теряет эту конкретную защиту). Заполненное
   * поле — обязательство, которое Runner проверяет за оператора: тот самый коммит на
   * `main` из AUTH-104 обнаружился только гейтом «Проверка предусловий публикации» на
   * этапе 7, когда правка уже легла на неверную ветку.
   */
  private async branchMismatchBlocker(): Promise<string | null> {
    const rawField = readField(readArtifact(this.paths.intent).text, 'Ветка витка');
    if (rawField === null) return null;
    const declared = branchNameFromField(rawField);
    if (!(await isRepo(this.project.projectRoot))) return null;

    const actual = await currentBranch(this.project.projectRoot);
    if (actual === declared) return null;
    return (
      `рабочее дерево на ветке «${actual}», а задача объявляет «${declared}» (intent.md → ` +
      `«Ветка витка»). Правка в этом состоянии легла бы не туда — переключись на нужную ветку ` +
      `сам (\`git checkout -b ${declared}\` или \`git checkout ${declared}\`) и начни попытку ` +
      `заново; Runner не переключает ветку автоматически, чтобы не тронуть незакоммиченное.`
    );
  }

  /** Отменяет текущий этап: и исполнителя, и всё, что ждёт ответа оператора. */
  cancel(reason: string): void {
    this.aborter?.abort();
    this.gate.cancelRun(this.id, reason);
    this.askGate.cancelRun(this.id);
    this.status = 'cancelled';
  }

  /**
   * Конец витка: гасим внешние MCP-серверы.
   *
   * Именно на конце витка, а не этапа. Погасив редактор между chunk и verify, мы отняли бы
   * у верификации ровно то состояние, которое она и проверяет, — и следующий этап платил
   * бы за подъём редактора заново.
   */
  async dispose(): Promise<void> {
    await this.hub.close();
  }

  async runStage(stage: StageId, opts: RunStageOptions = {}): Promise<StageResult> {
    const def = stageById(stage);
    const route = this.profile.routes[stage];
    const abortOpts = opts.abortHandoff === true ? { abortHandoff: true } : {};

    // Кэш предыдущего pre-flight сбрасывается ДО проверки блокеров ниже: если прошлая
    // попытка упала на пробе среды, `this.lastPreflightBlockers` от неё ещё не пуст, а
    // `blockers()` теперь подмешивает его в свой список (см. её комментарий) — без сброса
    // здесь виток заблокировал бы сам себя устаревшим результатом, ни разу не пройдя до
    // свежей проверки ниже, и retry стал бы физически недостижим.
    if (stage === 'verify') this.lastPreflightBlockers = [];

    // Предусловия считаются ОДИН раз: `blockers` вызывает `checkPreconditions` внутри,
    // и второй вызов рядом был чистым дублированием чтения артефактов, хотя комментарий
    // рядом утверждал обратное.
    const report = checkPreconditions(def, this.ctx, abortOpts);
    const blockers = this.blockers(stage, abortOpts, report);
    if (blockers.length > 0) {
      const message = blockers.join('\n');
      // Статус обязан отразить неудачный вход в этап: пока он оставался от предыдущего,
      // в списке витков заблокированный запуск выглядел как «этап пройден».
      this.status = 'failed';
      this.emit({ type: 'error', runId: this.id, stage, message });
      return { ok: false, finalText: '', usage: emptyUsage(), note: message };
    }

    if (report.skip !== null) {
      this.emit({ type: 'stage_done', runId: this.id, stage, ok: true, note: report.skip });
      return { ok: true, finalText: '', usage: emptyUsage(), note: report.skip };
    }

    // Только «Тесты»/«Сборка» реально идут через `runShell`, и только на этапе 6 — pre-flight
    // здесь, а не после запуска модели: несоответствие среды раньше обнаруживалось только
    // прогоном самих гейтов, то есть после того, как разведка и отчёт уже съели попытку.
    // До `nextAttempt()` (отдельный метод, не вызывается отсюда) — попытка не тратится.
    // ПОСЛЕ проверки `report.skip`, не до неё: у `verify` пропуска сегодня не бывает
    // (`stages.ts::skipIf` для него всегда `null`), но если он появится — pre-flight не
    // должен блокировать попытку, которая всё равно была бы пропущена без него.
    if (stage === 'verify') {
      const sandboxBlockers = await preflightBlockers(this.project.projectRoot, this.project.name);
      this.lastPreflightBlockers = sandboxBlockers;
      if (sandboxBlockers.length > 0) {
        const message = sandboxBlockers.join('\n');
        this.status = 'failed';
        this.emit({ type: 'error', runId: this.id, stage, message });
        return { ok: false, finalText: '', usage: emptyUsage(), note: message };
      }
    }

    // `chunk` — первый этап, где модель реально пишет в рабочее дерево (`Write`/`Edit`), но
    // не единственный, где доступен `Bash`: по `stages.ts` он разрешён также на `plan`,
    // `verify` и `handoff` (на `intent` — тоже, но поле «Ветка витка» ещё не заполнено на
    // входе в него, блокер там всегда `null` — перепроверять нечего). `git checkout` внутри
    // Bash-вызова может сменить ветку уже ПОСЛЕ того, как поле заполнено на `intent`, и
    // проверка только на входе в `chunk` эту смену не поймает вплоть до гейта «Проверка
    // предусловий публикации» на `handoff`, который находит её ПОСЛЕ коммита — ровно тот
    // постфактум-сценарий AUTH-104, ради которого блокер и заводился. Перепроверяем на
    // входе в каждый из этапов, где Bash в принципе доступен И поле уже может быть
    // заполнено. Не переключаем ветку автоматически: `git checkout` посреди грязного дерева
    // — свой источник потери рабочих файлов, а решение, что считать «текущей задачей»,
    // принимает человек.
    if (stage === 'plan' || stage === 'chunk' || stage === 'verify' || stage === 'handoff') {
      const branchBlocker = await this.branchMismatchBlocker();
      if (branchBlocker !== null) {
        this.status = 'failed';
        this.emit({ type: 'error', runId: this.id, stage, message: branchBlocker });
        return { ok: false, finalText: '', usage: emptyUsage(), note: branchBlocker };
      }
    }

    const { agents, missing } = loadSubagents(this.config.runner.agentsDir, def.subagents);
    if (missing.length > 0) {
      this.emit({
        type: 'warning',
        runId: this.id,
        stage,
        message:
          `не найдены определения субагентов: ${missing.join(', ')} (каталог ${this.config.runner.agentsDir}). ` +
          (stage === 'verify'
            ? 'Этап 6 пойдёт без независимого рецензента, а «Ревью независимым агентом» ' +
              'входит в минимальную пятёрку гейтов — вердикт этого витка неполон.'
            : 'Этап пойдёт без независимого агента: ограничение прав держится на промпте, ' +
              'а не на конструкции.'),
      });
    }

    this.emit({
      type: 'stage_started',
      runId: this.id,
      stage,
      flow: route.flow,
      provider: route.provider,
      model: route.model,
      chunk: this.chunk,
      attempt: this.attempt,
    });
    this.status = 'running';
    this.aborter = new AbortController();

    // Метрики этапа копятся на витке: сколько раз он запускался, сколько это стоило и
    // сколько занял. Время меряется здесь, а не по событиям шины: буфер шины вытесняет
    // старое, и считать по нему длительность значило бы терять её на длинных витках.
    const stageStartedAt = Date.now();
    const stat = this.stageStats.get(stage) ?? { runs: 0, usage: emptyUsage(), durationMs: 0 };
    stat.runs += 1;
    this.stageStats.set(stage, stat);

    if (stage === 'chunk') await this.ensureBaseline();

    // Гейты этапа 6 прогоняются до рецензента и подклеиваются к его входу: иначе он
    // судит по своему представлению о сборке и тестах, а не по их фактическому итогу.
    //
    // Подклеиваются ВСЕГДА, в том числе к промпту, который оператор редактировал.
    // Условие «только если промпт собран рантаймом» на практике не выполнялось никогда:
    // интерфейс отправляет содержимое textarea при каждом запуске, поэтому рецензент не
    // получал итогов гейтов ни разу, а оператор на каждом прогоне видел предупреждение
    // о правке, которой не делал. Блок фактов от прогона — не «дополнение промпта за
    // спиной»: без него этап 6 не исполняет порядок, ради которого он и устроен.
    let extra = opts.extra;
    /** Что подклеил сам рантайм — только это дописывается к промпту, отредактированному
     *  оператором. Раньше признак был выражен условием `stage === 'verify'` в месте
     *  склейки, и второй источник фактов (диагноз ретрая) туда бы просто не попал. */
    let appended: string | undefined;

    if (stage === 'verify') {
      const results = await this.runVerifyGates(this.aborter.signal);
      if (results.length > 0) {
        appended = gateReportBlock(results);
        extra = extra === undefined ? appended : `${extra}\n\n${appended}`;
      }
    }

    // Диагноз прошлой попытки — вход повторного chunk'а. Без него ретрай уходил тем же
    // промптом, что и первая попытка: причины красного посчитаны, но до исполнителя не
    // доезжали, и он заново угадывал, что именно не сошлось.
    if (stage === 'chunk' && this.carryForward !== null) {
      appended = this.carryForward;
      extra = extra === undefined ? appended : `${extra}\n\n${appended}`;
    }

    // Пост-виток отчёт — вход этапа 7, тем же механизмом, что и итоги гейтов на этапе 6:
    // модель переносит числа в артефакт, но не сочиняет их.
    if (stage === 'handoff') {
      const block = postmortemBlock(this.metrics);
      if (block !== null) {
        appended = block;
        extra = extra === undefined ? block : `${extra}\n\n${block}`;
      }
    }

    // Соединения к MCP поднимаются ДО сборки промпта: набор инструментов, показанный
    // оператору, обязан быть тем же, что уйдёт в модель, а он зависит от того, какие
    // серверы реально ответили.
    const mcp = await this.mcpAccess(stage);

    // Формы раскладываются ДО этапа: «заполни бланк» — задача другого класса, чем «создай
    // документ по форме», и на локальных моделях это ровно тот шаг, где они вставали.
    // Снимок отсутствующего берётся ДО раскладки: по нему потом видно, произвёл ли этап
    // хоть что-то, а существовавший ранее файл (набор гейтов проекта) доказательством не
    // считается.
    // Снимок рабочего дерева ДО этапа: «дерево не изменилось» обязано считаться против
    // него, а не против HEAD. Коммита до этапа 7 не бывает, поэтому правки прошлой попытки
    // и прошлого chunk'а остаются в дереве, и сравнение с HEAD объявляло бы результативной
    // любую попытку после первой удачной.
    const diffBefore =
      stage === 'chunk' ? await workingDiff(this.project.projectRoot, [], this.aborter?.signal) : '';

    // Строка трения заводится ДО исполнителя. Пока она создавалась первым же счётчиком,
    // этап, не сделавший ни одного вызова и не получивший ни одного напоминания, в метрики
    // не попадал вовсе — то есть самый тяжёлый исход выглядел как отсутствие трения, а
    // приписка в постмортеме обещала читателю строку «Вызовов: 0», которой не бывало.
    if (!this.friction.has(stage)) this.friction.set(stage, EMPTY_FRICTION());

    const produced = def.produces(this.ctx);
    const missingBefore = missingNow(produced);
    const seeded = seedArtifacts(produced, this.config.runner.methodologyDir);
    this.seeded = seeded.map((s) => s.path);

    // Что считается «этап ничего не произвёл»: файла нет ИЛИ он остался бланком байт в
    // байт. Без второй половины проверка стала бы самообманом — бланк кладёт сам рантайм.
    const notDone = (): string[] => [
      ...stillMissing(produced, missingBefore),
      ...untouchedSeeds(seeded),
    ];
    for (const path of this.seeded) {
      this.emit({
        type: 'warning',
        runId: this.id,
        stage,
        message: `форма разложена под артефакт ${path} — этап заполняет её, а не создаёт заново`,
      });
    }

    // Промпт пересобирается, когда есть что подклеить: иначе правка оператора и факты
    // прогона исключали бы друг друга. Правка человека при этом сохраняется — она
    // приходит отдельными полями `system`/`user`.
    const prompt =
      opts.prompt === undefined
        ? this.preparePrompt(stage, {
            ...(opts.requirement === undefined ? {} : { requirement: opts.requirement }),
            ...(extra === undefined ? {} : { extra }),
          })
        : withExtra(opts.prompt, appended);
    if (opts.prompt !== undefined) {
      this.emit({ type: 'prompt_prepared', runId: this.id, stage, prompt });
    }

    // `let`, не `const`: одобренный `request_scope_extension` дописывает `plan.md` на диске
    // и пересчитывает `ctx` из него же — без переприсвоения политика этого же прогона
    // видела бы старый `files_to_touch` до самого конца этапа, и одобренная человеком
    // правка всё равно отклонялась бы следующим же `Write` в тот же путь.
    let ctx = this.policyContext(stage);
    /** Вызовы субагента-рецензента, ждущие результата: по ним ставится факт ревью. */
    const pendingReviewer = new Set<string>();
    /** Команда bash по requestId — только для вызовов, дошедших до исполнения: `onToolResult`
     * знает исход, но не сам вызов, `recordBashResult` гейта нужны оба. */
    const pendingBash = new Map<string, string>();
    /**
     * Имена, под которыми у этого этапа объявлен независимый рецензент, — и только они.
     *
     * Пересечение объявленного этапом списка с реестром рецензентов, а не поиск подстроки
     * в имени: гейт минимальной пятёрки не может зажигаться от того, как модель назвала
     * вызванного агента. Пусто — рецензента этап не объявлял, и зажечь гейт нечем.
     */
    const reviewerNames = new Set(def.subagents.filter((n) => REVIEWER_AGENTS.includes(n)));

    const hooks: ExecHooks = {
      onText: (text) => this.emit({ type: 'assistant_text', runId: this.id, stage, text }),
      onThinking: (text) => this.emit({ type: 'thinking', runId: this.id, stage, text }),

      onToolRequest: async (call, meta) => {
        this.status = 'awaiting';
        try {
          const decision = await this.gate.request({
            runId: this.id,
            stage,
            requestId: meta.requestId,
            toolName: meta.toolName,
            rawInput: meta.rawInput,
            call,
            // Права вызывающего СУЖАЮТ права этапа, но никогда их не расширяют:
            // пересечение, а не подстановка. Вложенный субагент не может получить больше
            // этапа, а объявленный без права записи разведчик не получает `Write` только
            // потому, что модель его назвала.
            ctx: {
              ...ctx,
              allowedTools: ctx.allowedTools.filter((t) => meta.callerTools.includes(t)),
            },
          });
          // Рецензентом считается ровно тот субагент, чьё определение этап объявил и
          // рантайм прочитал с диска. Подстрока «reviewer» в имени этой планкой не
          // является: модель, вызвавшая несуществующего `code-reviewer-helper`, получала
          // отказ загрузки — и всё равно зажигала гейт минимальной пятёрки.
          if (decision.allowed && call.kind === 'subagent' && reviewerNames.has(call.agent)) {
            pendingReviewer.add(meta.requestId);
          }
          if (decision.allowed && call.kind === 'bash') {
            // `call.command` — то, что ПРЕДЛОЖИЛА модель, не обязательно то, что реально
            // исполнится: оператор мог поправить команду через approve-with-edit
            // (`decision.updatedInput`), и оба исполнителя (`SdkExecutor`/`LoopExecutor`)
            // запускают именно правленый ввод. `recordBashResult` считает повторы по
            // фактически исполненной команде — иначе три РАЗНЫЕ команды, которые оператор
            // одну за другой правил после провала, засчитывались бы как одна и та же.
            const effective =
              decision.updatedInput === null
                ? call
                : normalize(meta.toolName, decision.updatedInput as Record<string, unknown>);
            pendingBash.set(meta.requestId, effective.kind === 'bash' ? effective.command : call.command);
          }
          // Человек одобрил расширение scope — дописываем `plan.md` и пересчитываем `ctx`
          // из него ЖЕ, до возврата решения: следующий вызов этого же прогона (обычно —
          // Write в только что одобренный путь) обязан увидеть новый `files_to_touch`,
          // а не версию, посчитанную в начале этапа.
          if (decision.allowed && call.kind === 'request_scope_extension') {
            const note = `расширено на этапе ${stage} · ${decisionValue(this.config.runner.operator, new Date())} — ${call.reason}`;
            const planText = readArtifact(this.paths.plan).text;
            const updated = appendScopeExtension(planText, call.path, note);
            if (updated === null) {
              // Одобрение человека остаётся в силе (решение о том, что расширение —
              // хорошая идея, не отменяется), но САМ вызов инструмента не выполнен —
              // технически дописать план не удалось. Раньше здесь возвращался исходный
              // `decision` (allowed: true) без изменений, и модель получала текст «путь
              // добавлен — теперь можно писать» безусловно, хотя `ctx.planFiles` не
              // обновился и следующий Write в этот путь всё равно падал на planScope —
              // модель узнавала о провале только на попытке записи, без объяснения
              // противоречия. Честнее — отказать ЭТОМУ вызову сейчас, с причиной: тот же
              // канал (`decision.reason`), которым уже пользуется отказ политики.
              const message =
                `человек одобрил расширение scope на «${call.path}», но в plan.md не нашлась ` +
                `строка «Добавлено сверх разведки» — файл, видимо, правлен вручную не по форме. ` +
                `Путь НЕ добавлен в files_to_touch; поправь plan.md вручную или попроси ` +
                `человека сделать это, прежде чем повторять запрос.`;
              this.emit({ type: 'warning', runId: this.id, stage, message });
              const denied: Decision = { allowed: false, reason: message, by: 'policy' };
              return denied;
            }
            writeArtifact(this.paths.plan, updated);
            ctx = this.policyContext(stage);
          }
          return decision;
        } finally {
          this.status = 'running';
        }
      },

      onToolResult: (meta) => {
        this.countFriction(stage, 'toolCalls');
        // Гейт «Ревью независимым агентом» зеленеет только по факту состоявшегося
        // прогона рецензента, и вот он, этот факт: вызов дошёл до результата без ошибки.
        if (meta.ok && pendingReviewer.has(meta.requestId)) this.markReviewerRan();
        pendingReviewer.delete(meta.requestId);

        const bashCommand = pendingBash.get(meta.requestId);
        if (bashCommand !== undefined) {
          this.gate.recordBashResult(this.id, bashCommand, meta.ok);
          pendingBash.delete(meta.requestId);
        }

        this.emit({
          type: 'tool_result',
          runId: this.id,
          stage,
          requestId: meta.requestId,
          ok: meta.ok,
          summary: meta.summary,
          durationMs: meta.durationMs,
          ...(meta.detail === undefined ? {} : { detail: meta.detail }),
        });
      },

      onAskHuman: async (call) => {
        if (call.kind !== 'ask_human') return {};
        this.status = 'awaiting';
        try {
          return await this.askGate.ask({ runId: this.id, stage, questions: call.questions });
        } finally {
          this.status = 'running';
        }
      },

      onUsage: (usage) => {
        const st = this.stageStats.get(stage);
        if (st !== undefined) st.usage = addUsage(st.usage, usage);
        this.totalUsage = addUsage(this.totalUsage, usage);
        this.emit({ type: 'usage', runId: this.id, stage, usage, total: this.totalUsage });
      },

      onWarn: (message) => this.emit({ type: 'warning', runId: this.id, stage, message }),

      onFriction: (kind) => this.countFriction(stage, kind),
    };

    try {
      // Исполнитель создаётся ВНУТРИ try: `createProvider` бросает при отсутствии ключа
      // и на нереализованном маршруте, а к этому моменту уже отправлен `stage_started`,
      // выставлен статус `running` и — для этапа 6 — прогнаны все гейты, то есть сборка
      // и тест-сьют. Пока бросок случался снаружи, `finally` не отрабатывал: статус
      // навсегда оставался `running`, `stage_done` не приходил, и кнопка запуска в
      // интерфейсе не разблокировалась до перезагрузки страницы.
      const executor = this.executorFor(stage);

      const result = await executor.run(
        {
          prompt,
          cwd: this.project.projectRoot,
          model: route.model,
          allowedTools: this.toolsFor(stage),
          readOnlyDirs: this.readOnlyRoots,
          subagents: agents,
          mcp,
          // «Ход завершён» и «работа сделана» — разные утверждения, и второе проверяется
          // диском. Замечание даёт модели доделать в том же этапе, а не отчитаться пустым.
          finishGuard: () => {
            const missing = notDone();
            if (missing.length === 0) return null;
            return (
              `артефакт этапа не заполнен: ${missing.join(', ')}. Ход не закончен — ` +
              `открой файл, замени места «‹…›» своим содержимым и сохрани инструментом Edit.`
            );
          },
          // Спасение напечатанного артефакта: модель составила его правильно, но не
          // записала. Идёт тем же путём, что обычная запись — политика и гейт одобрения.
          salvageFromText: (text) => this.salvageFromText(text, produced, stage),
          maxTurns: this.config.runner.limits.maxIterationsPerStage,
          maxBudgetUsd: this.project.maxBudgetUsd,
          spentUsdBefore: this.totalUsage.costUsd ?? 0,
          signal: this.aborter.signal,
        },
        hooks,
      );

      if (stage === 'verify') await this.runEnsembleReviewers(prompt, def, agents, hooks);

      // Отмена проверяется ДО записи улик. Иначе отменённый этап затирал патч предыдущего
      // состояния снимком наполовину сделанного дерева (а при прерванном сигнале git
      // отдаёт пустой вывод, то есть улика подменялась ложным «правок нет») и запускал
      // тест-сьют, который уже некому ждать.
      const cancelled = this.aborter?.signal.aborted === true;

      // Свидетельства попытки — патч и запись о тестах — производит рантайм, перезаписывая
      // то, что записал агент. Иначе вход этапа 6 остаётся рассказом исполнителя о самом
      // себе; замер поймал ровно этот случай (см. `evidence.ts`).
      if (stage === 'chunk' && !cancelled) {
        this.chunkTree = await this.recordEvidence(diffBefore);
      }

      this.reportArtifacts(stage);

      if (cancelled) {
        this.status = 'cancelled';
        const note = 'этап отменён оператором';
        this.emit({ type: 'stage_done', runId: this.id, stage, ok: false, note });
        return { ...result, ok: false, note };
      }

      // Вердикт считается сразу после этапа 6 — по отчёту, который только что записан,
      // и по прогону гейтов, который был до ревью. Отдельной кнопки у него нет: вердикт,
      // который надо не забыть посчитать, рано или поздно не считают.
      if (stage === 'verify') this.computeStageVerdict(this.detectNoProgress());

      // Последнее слово об исходе — за диском, а не за исполнителем. Модель, объявившая
      // ход завершённым и не записавшая ни одного из объявленных этапом артефактов,
      // прошедшим этап не считается: во флоу `loop` она уже получила два напоминания, а
      // во флоу `sdk` цикл крутит харнесс, и другого места для этой проверки нет.
      const missingAfter = notDone();
      const failedSilently = result.ok && missingAfter.length > 0;
      // Пустое дерево после этапа 5 — самостоятельный провал, наравне с незаполненным
      // артефактом: свидетельства теперь кладёт рантайм, то есть «файлы на месте» перестало
      // быть признаком сделанной работы. `unknown` роняет этап по той же причине — состояние
      // дерева неизвестно, и считать его успехом значит зеленеть на непроверенном.
      const treeProblem =
        result.ok && stage === 'chunk' && this.chunkTree !== 'changed'
          ? this.chunkTree === 'empty'
            ? 'этап закончился, но дерево не изменилось: правки не было'
            : 'этап закончился, но состояние дерева неизвестно: свидетельства попытки не записаны'
          : null;
      const outcome = failedSilently
        ? {
            ...result,
            ok: false,
            note: `этап закончился, но артефакт не заполнен: ${missingAfter.join(', ')}`,
          }
        : treeProblem !== null
          ? { ...result, ok: false, note: treeProblem }
          : result;

      this.status = outcome.ok ? 'done' : 'failed';
      this.emit({ type: 'stage_done', runId: this.id, stage, ok: outcome.ok, note: outcome.note });
      return outcome;
    } catch (e) {
      const message = (e as Error).message;
      this.status = 'failed';
      this.gate.cancelRun(this.id, `этап оборван: ${message}`);
      this.askGate.cancelRun(this.id);
      this.emit({ type: 'error', runId: this.id, stage, message });
      return { ok: false, finalText: '', usage: emptyUsage(), note: message };
    } finally {
      stat.durationMs += Date.now() - stageStartedAt;
      this.aborter = null;
    }
  }

  /**
   * Детект отсутствия прогресса: с третьей попытки diff предыдущей сравнивается с diff
   * позапрошлой. Два подряд одинаковых — это остановка, а не следующая попытка.
   *
   * Сравнение дословное. «По существу» отличалось бы от «побайтово» только на шуме вроде
   * таймстампов, а угадывать, что считать шумом, здесь опаснее, чем изредка дать лишнюю
   * попытку: ложная эскалация дороже ложного продолжения.
   */
  detectNoProgress(): boolean {
    // Сравниваются ТЕКУЩАЯ попытка и предыдущая. Патч текущей к моменту вердикта уже
    // существует — он обязательное предусловие этапа 6. Пока сравнивались две прошлые,
    // одинаковые попытки 1 и 2 обнаруживались только на третьей: целая итерация бюджета
    // тратилась на заведомо известный факт.
    this.closeness = null;
    if (this.attempt < 2) return false;
    const current = readArtifact(this.paths.chunkDiff(this.chunk, this.attempt));
    const prev = readArtifact(this.paths.chunkDiff(this.chunk, this.attempt - 1));
    if (!current.exists || !prev.exists) return false;

    // Патчи читаются один раз на вердикт и здесь же обслуживают обе меры: они бывают
    // сотнями килобайт, и второй проход по диску ради числа для интерфейса не нужен.
    this.closeness = diffCloseness(prev.text, current.text);
    return current.text.trim() === prev.text.trim();
  }

  /** Близость патча к патчу прошлой попытки. `null` — первая попытка или сравнивать нечего. */
  get progressCloseness(): number | null {
    return this.closeness;
  }

  /** Сообщает о произведённых артефактах и о том, сколько мест в них осталось незаполненными. */
  private reportArtifacts(stage: StageId): void {
    for (const path of stageById(stage).produces(this.ctx)) {
      const a = readArtifact(path);
      if (!a.exists) continue;
      this.emit({
        type: 'artifact_written',
        runId: this.id,
        stage,
        path,
        placeholders: a.placeholders,
      });
    }
  }
}
