/**
 * Машина витка: один прогон одного этапа за раз.
 *
 * Состояние живёт на диске, в `.sdlc/<slug>/` целевого проекта, а не в памяти процесса.
 * Поэтому предусловия проверяются чтением файлов: виток переживает перезапуск сервиса,
 * а начатый в терминале скиллами `/sdlc-*` продолжается здесь и наоборот.
 */

import { randomUUID } from 'node:crypto';

import type {
  EventSink,
  GateRunResult,
  GateStatus,
  PolicyContext,
  PreparedPrompt,
  StageId,
  Usage,
  Verdict,
} from '@sdlc-runner/shared';
import { addUsage, emptyUsage } from '@sdlc-runner/shared';

import { statSync } from 'node:fs';

import { decisionValue, readArtifact, setDecision, writeArtifact } from '../artifacts/artifact.ts';
import { WitokPaths, artifactPathOf, isArtifactKey } from '../artifacts/paths.ts';
import { extractFilesToTouch } from '../artifacts/planFiles.ts';
import type { AskGate } from '../approval/askGate.ts';
import type { ApprovalGate } from '../approval/gate.ts';
import type { LoadedConfig } from '../config/load.ts';
import type { ProjectConfig, ResolvedProfile } from '../config/schema.ts';
import { LoopExecutor } from '../exec/LoopExecutor.ts';
import { SdkExecutor } from '../exec/SdkExecutor.ts';
import { createProvider } from '../provider/registry.ts';
import type { ExecHooks, StageExecutor, StageResult } from '../exec/StageExecutor.ts';
import { loadSubagents } from '../exec/subagents.ts';
import type { GatesFile } from '../gates/gatesFile.ts';
import { configProblems, gateKey, parseGates } from '../gates/gatesFile.ts';
import { snapshotBaseline } from '../gates/builtin/index.ts';
import { runGates } from '../gates/run.ts';
import { collectVerdictInput } from '../verdict/collect.ts';
import { computeVerdict } from '../verdict/verdict.ts';
import { buildPrompt } from '../prompt/build.ts';
import {
  checkPreconditions,
  stageById,
  type PreconditionReport,
  type StageContext,
} from './stages.ts';

export type RunStatus = 'idle' | 'running' | 'awaiting' | 'done' | 'failed' | 'cancelled';

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
  private verdict: Verdict | null = null;
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
  }

  get ctx(): StageContext {
    return { paths: this.paths, chunk: this.chunk, attempt: this.attempt };
  }

  /** Итоги последнего прогона гейтов — для интерфейса. */
  get gateResults(): GateRunResult[] {
    return [...this.lastGateResults];
  }

  get lastVerdict(): Verdict | null {
    return this.verdict;
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
    this.attempt += 1;
    this.resetAttemptState();
    return this.attempt;
  }

  /** Следующий chunk витка: нумерация попыток начинается заново. */
  nextChunk(): number {
    this.chunk += 1;
    this.attempt = 1;
    this.resetAttemptState();
    return this.chunk;
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
    this.verdict = null;
    this.reviewerRan = false;
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
      allowedTools: def.tools,
    };
  }

  private executorFor(stage: StageId): StageExecutor {
    const route = this.profile.routes[stage];
    if (route.flow === 'sdk') return new SdkExecutor();

    const limits = this.config.runner.limits;
    return new LoopExecutor({
      provider: createProvider(route.provider, route.providerDef, limits.chatTimeoutMs),
      maxResultBytes: limits.maxToolResultBytes,
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
    const def = stageById(stage);
    const route = this.profile.routes[stage];
    const prompt = buildPrompt({
      runner: this.config.runner,
      stage: def,
      ctx: this.ctx,
      flow: route.flow,
      slug: this.slug,
      now: new Date(),
      ...(opts.requirement === undefined ? {} : { requirement: opts.requirement }),
      ...(opts.extra === undefined ? {} : { extra: opts.extra }),
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
      }
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

    const results = await runGates({
      gates,
      projectRoot: this.project.projectRoot,
      planFiles: this.planFilesFor('verify') ?? [],
      baseline: this.readBaseline(),
      timeoutMs: this.config.runner.limits.gateTimeoutMs,
      ...(signal === undefined ? {} : { signal }),
      externalStatuses: this.externalGateStatuses(),
      onResult: (gate) => this.emit({ type: 'gate_result', runId: this.id, stage: 'verify', gate }),
    });
    this.lastGateResults = results;
    return results;
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

    const report = readArtifact(this.paths.verificationReport(this.chunk, this.attempt));
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
      report: report.text,
      attempt: this.attempt,
      attemptBudget: this.attemptBudget,
      noProgress,
    });

    const verdict = computeVerdict(input);
    // Расхождение отчёта с прогоном не роняет вердикт само по себе (в статус уже взят
    // худший из двух), но обязано быть видно: рецензент, переписывающий статусы, —
    // отдельный симптом, о котором оператор должен узнать.
    const withNotes: Verdict =
      disagreements.length === 0
        ? verdict
        : { ...verdict, reasons: [...verdict.reasons, ...disagreements] };

    this.verdict = withNotes;
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
  }

  /** Отменяет текущий этап: и исполнителя, и всё, что ждёт ответа оператора. */
  cancel(reason: string): void {
    this.aborter?.abort();
    this.gate.cancelRun(this.id, reason);
    this.askGate.cancelRun(this.id);
    this.status = 'cancelled';
  }

  async runStage(stage: StageId, opts: RunStageOptions = {}): Promise<StageResult> {
    const def = stageById(stage);
    const route = this.profile.routes[stage];
    const abortOpts = opts.abortHandoff === true ? { abortHandoff: true } : {};

    // Предусловия считаются ОДИН раз: `blockers` вызывает `checkPreconditions` внутри,
    // и второй вызов рядом был чистым дублированием чтения артефактов, хотя комментарий
    // рядом утверждал обратное.
    const report = checkPreconditions(def, this.ctx, abortOpts);
    const blockers = this.blockers(stage, abortOpts, report);
    if (blockers.length > 0) {
      const message = blockers.join('\n');
      this.emit({ type: 'error', runId: this.id, stage, message });
      return { ok: false, finalText: '', usage: emptyUsage(), note: message };
    }

    if (report.skip !== null) {
      this.emit({ type: 'stage_done', runId: this.id, stage, ok: true, note: report.skip });
      return { ok: true, finalText: '', usage: emptyUsage(), note: report.skip };
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
    if (stage === 'verify') {
      const results = await this.runVerifyGates(this.aborter.signal);
      if (results.length > 0) {
        const block = gateReportBlock(results);
        extra = extra === undefined ? block : `${extra}\n\n${block}`;
      }
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
        : withExtra(opts.prompt, stage === 'verify' ? extra : undefined);
    if (opts.prompt !== undefined) {
      this.emit({ type: 'prompt_prepared', runId: this.id, stage, prompt });
    }

    const ctx = this.policyContext(stage);
    /** Вызовы субагента-рецензента, ждущие результата: по ним ставится факт ревью. */
    const pendingReviewer = new Set<string>();
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
            ctx,
          });
          // Рецензентом считается ровно тот субагент, чьё определение этап объявил и
          // рантайм прочитал с диска. Подстрока «reviewer» в имени этой планкой не
          // является: модель, вызвавшая несуществующего `code-reviewer-helper`, получала
          // отказ загрузки — и всё равно зажигала гейт минимальной пятёрки.
          if (decision.allowed && call.kind === 'subagent' && reviewerNames.has(call.agent)) {
            pendingReviewer.add(meta.requestId);
          }
          return decision;
        } finally {
          this.status = 'running';
        }
      },

      onToolResult: (meta) => {
        // Гейт «Ревью независимым агентом» зеленеет только по факту состоявшегося
        // прогона рецензента, и вот он, этот факт: вызов дошёл до результата без ошибки.
        if (meta.ok && pendingReviewer.has(meta.requestId)) this.markReviewerRan();
        pendingReviewer.delete(meta.requestId);

        this.emit({
          type: 'tool_result',
          runId: this.id,
          stage,
          requestId: meta.requestId,
          ok: meta.ok,
          summary: meta.summary,
          durationMs: meta.durationMs,
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
        this.totalUsage = addUsage(this.totalUsage, usage);
        this.emit({ type: 'usage', runId: this.id, stage, usage, total: this.totalUsage });
      },

      onWarn: (message) => this.emit({ type: 'warning', runId: this.id, stage, message }),
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
          allowedTools: def.tools,
          readOnlyDirs: this.readOnlyRoots,
          subagents: agents,
          maxTurns: this.config.runner.limits.maxIterationsPerStage,
          maxBudgetUsd: this.project.maxBudgetUsd,
          signal: this.aborter.signal,
        },
        hooks,
      );

      this.reportArtifacts(stage);

      // Отмена не переписывается исходом исполнителя. Пока статус выставлялся безусловно,
      // отменённый оператором этап числился `failed`, а при удачном тайминге во флоу
      // `sdk` (поток успел закрыться штатным result:success) — даже `done`.
      const cancelled = this.aborter?.signal.aborted === true;
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
      this.status = result.ok ? 'done' : 'failed';
      this.emit({ type: 'stage_done', runId: this.id, stage, ok: result.ok, note: result.note });
      return result;
    } catch (e) {
      const message = (e as Error).message;
      this.status = 'failed';
      this.gate.cancelRun(this.id, `этап оборван: ${message}`);
      this.askGate.cancelRun(this.id);
      this.emit({ type: 'error', runId: this.id, stage, message });
      return { ok: false, finalText: '', usage: emptyUsage(), note: message };
    } finally {
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
    if (this.attempt < 2) return false;
    const current = readArtifact(this.paths.chunkDiff(this.chunk, this.attempt));
    const prev = readArtifact(this.paths.chunkDiff(this.chunk, this.attempt - 1));
    if (!current.exists || !prev.exists) return false;
    return current.text.trim() === prev.text.trim();
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
