/**
 * Типы декларации этапов витка — общие для модулей этапов, реестра и сборки промпта.
 *
 * Отдельным файлом без значений: `prompt/build.ts` берёт отсюда типы, не подтягивая модули
 * этапов, а те — рантайм витка. Иначе импорт промпта замыкал бы цикл модулей.
 */

import type { ArtifactKey, WitokPaths } from '../../artifacts/paths.ts';
import type { ApprovalGate } from '../../approval/gate.ts';
import type { LoadedConfig } from '../../config/load.ts';
import type { ModuleProfile, ProjectConfig, ResolvedRoute } from '../../config/schema.ts';
import type { McpAccess, StageExecutor } from '../../exec/StageExecutor.ts';
import type { EcosystemLine } from '../../explore/view.ts';
import type { GatesFile } from '../../gates/gatesFile.ts';
import type { TraceLabel } from '../../provider/rawLog.ts';
import type { ExploreState } from './explore.ts';
import type { VerifyState } from './verify/state.ts';
import type { ChunkEvidenceMetric, Decision, EventSink, PolicyContext, StageId, ToolName, Usage } from '@sdlc-runner/shared';

/** Бланк, разложенный под артефакт этапа; `snapshot` — содержимое после автозаполнения. */
export type SeededArtifact = { path: string; snapshot?: string };

/**
 * Фасад витка для модулей этапов: ровно то, что им нужно, без доступа к классу `Run`.
 * Модуль этапа импортирует `Run.ts` только как тип — иначе реестр этапов замкнул бы цикл
 * модулей. Всё изменяемое отдаётся функциями, а не значениями, снятыми на входе.
 */
export interface StageHost {
  readonly id: string;
  readonly slug: string;
  readonly paths: WitokPaths;
  readonly projectRoot: string;
  readonly emit: EventSink;
  /** Запись автозаполнения с обновлением снимка бланка (`Run.writeAutofilled`). */
  writeAutofilled(path: string, text: string, seeded: SeededArtifact[]): void;
  /** HEAD проекта: sha либо причина его отсутствия (`Run.head`). */
  head(): Promise<{ sha: string | null; why: string }>;
  /** Разобранный набор гейтов проекта; `null` — файла нет (`Run.gatesFile`). */
  gatesFile(): GatesFile | null;
  /** Пункты приёмочного листа задачи по id (`Run.intentClaimLines`). */
  intentClaimLines(intentText?: string): Map<string, string>;
  policyContext(stage: StageId): PolicyContext;
  trace(stage: StageId, mode: TraceLabel['mode']): TraceLabel;
  /** Расход вызовов модели мимо исполнителя этапа — в метрики и бюджет (`Run.accountOffPathUsage`). */
  accountOffPathUsage(stage: StageId, usage: Usage, currency: string | undefined): void;
  /**
   * Идентификатор синтетического вызова рантайма (`salvage-N`, `records-N`, `axis-fill-N`).
   * Счётчик один на виток: разнесённые по модулям счётчики сдвинули бы id событий шины.
   */
  syntheticRequestId(prefix: 'salvage' | 'records' | 'axis-fill'): string;
  /** Запись рантайма через гейт одобрения — тем же путём, что любая запись исполнителя. */
  requestApproval(req: Parameters<ApprovalGate['request']>[0]): Promise<Decision>;
  /** Сигнал отмены текущего этапа; без этапа — свежий, никогда не отменяемый. */
  signal(): AbortSignal;
  limits(): LoadedConfig['runner']['limits'];
  /** Конфиг раннера: каталоги субагентов и эталона методологии. */
  runner(): LoadedConfig['runner'];
  /** Чем проект собирается — тем же источником, что у гейтов (`Run.ecosystemFor`). */
  ecosystemFor(stage: StageId): EcosystemLine[];
  /** Включён ли гейт «Разбор последствий» с отчётом на этапе 4 (`stages/plan.ts::axesGateRow`). */
  axesEnabled(): boolean;
  /** Состояние этапа 2 между вызовами — живая ссылка на `Run.state.explore`. */
  readonly exploreState: ExploreState;
  /** Состояние попытки этапа 6 — живая ссылка на `Run.state.verify`. */
  readonly verifyState: VerifyState;
  /** Имя проекта — ключ реестра песочниц (`ensureSandboxFor`). */
  readonly projectName: string;
  /** Описание модулей проекта из конфига; `undefined` — модули определяет детект. */
  projectModules(): ModuleProfile[] | undefined;
  /** Разрешённые планом пути записи этапа (`Run.planFilesFor`). */
  planFilesFor(stage: StageId): readonly string[] | null;
  /** Номер текущего chunk'а. */
  chunk(): number;
  /** Номер текущей попытки chunk'а. */
  attempt(): number;
  /** Бюджет попыток chunk'а из набора гейтов (`Run.attemptBudget`). */
  attemptBudget(): number;
  /** Диагноз прошлой попытки — вход повторного chunk'а; `null` — первая попытка. */
  carryForward(): string | null;
  /** Улика попытки chunk'а в метрики витка (`RunMetrics.chunkEvidence`). */
  noteChunkEvidence(metric: ChunkEvidenceMetric): void;
  /**
   * Сигнал отмены текущего этапа как есть — `undefined` вне этапа. В отличие от `signal()`,
   * без подстановки свежего: контекст гейта без этапа не должен нести ключ `signal` вовсе.
   */
  aborterSignal(): AbortSignal | undefined;
  /** Факт состоявшегося независимого ревью на этой попытке (`Run.markReviewerRan`). */
  markReviewerRan(): void;
  /** Права этапа с учётом MCP и урезанного набора (`Run.toolsFor`). */
  toolsFor(stage: StageId): readonly ToolName[];
  /** Исполнитель этапа под маршрут (`Run.executorFor`). */
  executorFor(stage: StageId, route?: ResolvedRoute): StageExecutor;
  /** Инструменты внешних MCP-серверов этапа (`Run.mcpAccess`). */
  mcpAccess(stage: StageId): Promise<McpAccess | null>;
  /** Потолок ходов этапа (`Run.maxTurnsFor`). */
  maxTurnsFor(stage: StageId): number;
  /** Каталоги, открытые только на чтение (`Run.readOnlyRoots`). */
  readOnlyRoots(): string[];
  readonly maxBudgetUsd: ProjectConfig['maxBudgetUsd'];
  /** Уже потрачено в валюте маршрута — вход бюджета исполнителя. */
  spentBefore(currency: string): number;
  /** Основной маршрут этапа 6 (`profile.routes.verify`). */
  verifyRoute(): ResolvedRoute;
  /** Маршруты ансамбля этапа 6, первый — основной (`profile.ensemble.verify`). */
  ensembleRoutes(): readonly ResolvedRoute[];
}

/** Механическое поле артефакта, которое заполняет рантайм до модели (`formAutofill.ts`). */
export interface MechanicalJob {
  path: string;
  fill(text: string): Promise<{ text: string; filled: number }>;
  /**
   * Звать и при нуле плейсхолдеров. Меню «Разведка» отчёта по вопросам плейсхолдера не
   * несёт по построению: счётчик пропускал его, когда прочие места уже закрыты, и обе
   * ветки оставались навсегда.
   */
  evenWithoutPlaceholders?: boolean;
}

/** Модуль этапа витка: определение и то, чем этап отличается в рантайме. */
export interface StageModule {
  def: StageDef;
  /**
   * Исполняется ли этап режимом заполнения по полям (`ModelDef.formFill`). Только этапы,
   * чей результат целиком выводится из входов промпта: у explore источник — разведка
   * субагентами, у chunk/verify — работа с деревом, им режим не подходит по построению.
   *
   * У этапа 3 — нет, и это не пропуск. У `FormFillExecutor` нет `AskHuman` по построению
   * (вопрос человеку требует цикла) — а этап 3 состоит ровно из вопроса человеку. Живой
   * виток на `ministral-8b` показал, во что это обходится: в `clarification-report.md`
   * записан вопрос «как обрабатывать сумму измерений ровно 300 см?» и тут же собственный
   * ответ «(пропущено)», ни одного вызова `AskHuman`, весь этап — один `Write` за 7 секунд.
   * Ставку, которую задача прямо называет незаписанной, никто не спросил, и все три
   * human-кейса скрытых тестов покраснели — щуп мерил нашу конструкцию, а не модель.
   */
  formFillExecutor: boolean;
  /**
   * Действует ли урезанный набор инструментов (`ModelDef.leanTools`): этапы-документы.
   * Их результат — заполненный бланк, и Write/Glob/Grep там лишние: формы уже разложены
   * рантаймом (Edit достаточно), а поиск по дереву съедает ходы, не давая записи.
   * У chunk и verify — нет намеренно: там весь набор нужен по делу. У explore тоже:
   * права субагентов — ПЕРЕСЕЧЕНИЕ с правами этапа, и урезанный explore оставил бы
   * разведчиков (`sdlc-claims`, Grep/Glob) с одним Read — разведка калечилась бы молча.
   */
  leanDocTools: boolean;
  /** Механические поля артефактов этапа, закрываемые рантаймом до модели. */
  mechanicalJobs?(host: StageHost): MechanicalJob[];
}

export interface StageContext {
  paths: WitokPaths;
  /** Номер chunk'а витка, с 1. */
  chunk: number;
  /** Номер попытки текущего chunk'а, с 1. */
  attempt: number;
}

export interface Precondition {
  /** Что требуется — показывается оператору как есть. */
  describe: string;
  /** `null` — выполнено; строка — причина, по которой этап не начинается. */
  check: (c: StageContext) => string | null;
  /**
   * Артефакт, который проверяет условие, — по нему называется этап-виновник
   * (`stageProducing`). Без него «этап не стартовал» читался провалом этого этапа, хотя
   * завалил его артефакт ПРЕДЫДУЩЕГО, помеченного `ok` (8 из 25 прогонов серии v4).
   * Зовётся только для проваленного условия; `null` — вину не несёт этап-производитель
   * (например, недостаёт решения человека, а форма цела).
   */
  artifact?: (c: StageContext) => string | null;
}

export interface StageDef {
  id: StageId;
  /** Каталог скилла в `runner.skillsDir`, откуда берётся тело системного промпта. */
  skill: string;
  title: string;
  tools: readonly ToolName[];
  /** Субагенты, которых методология требует именно на этом этапе. */
  subagents: readonly string[];
  produces: (c: StageContext) => string[];
  requires: readonly Precondition[];
  /**
   * Артефакты, которые агент не вправе переписывать на этом этапе: решения человека и
   * конфигурация процесса. Агент, который может переписать одобренный план, может снять
   * с себя любое ограничение.
   */
  protectedArtifacts: (c: StageContext) => string[];
  /**
   * Поле решения человека, без которого следующий этап не начинается.
   *
   * Артефакт назван ключом, а не путём: тот же ключ приходит из интерфейса, когда
   * оператор записывает решение, и путь по нему собирает рантайм.
   */
  humanGate: { artifact: ArtifactKey; label: string } | null;
  /** Причина пропустить этап, либо `null`. */
  skipIf: ((c: StageContext) => string | null) | null;
}

export interface StageInput {
  path: string;
  /** Необязательный вход: отсутствие файла не мешает этапу. */
  optional: boolean;
}

export interface PreconditionProblem {
  text: string;
  /** Путь артефакта, завалившего условие; `null` — условие не привязано к артефакту. */
  artifact: string | null;
}

export interface PreconditionReport {
  ok: boolean;
  /** Причины, по которым этап не начинается. Собираются все сразу. */
  problems: string[];
  /** Те же причины с артефактом каждой — для называния этапа-виновника. */
  details: PreconditionProblem[];
  /** Причина пропустить этап, если он условный. */
  skip: string | null;
}

export interface PreconditionOptions {
  /** Оператор объявил обрыв витка: handoff оформляет передачу без зелёного вердикта. */
  abortHandoff?: boolean;
  /**
   * Считать ли артефакт каждой причины (`details[].artifact`). У `granted` это второе чтение
   * файла, а GET-опрос витка виновника не показывает — `false` там экономит чтение.
   */
  withArtifacts?: boolean;
}
