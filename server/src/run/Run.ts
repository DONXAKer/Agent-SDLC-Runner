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

import { readArtifact, writeArtifact } from '../artifacts/artifact.ts';
import { WitokPaths } from '../artifacts/paths.ts';
import { extractFilesToTouch } from '../artifacts/planFiles.ts';
import type { AskGate } from '../approval/askGate.ts';
import type { ApprovalGate } from '../approval/gate.ts';
import type { LoadedConfig } from '../config/load.ts';
import type { ProjectConfig, ResolvedProfile } from '../config/schema.ts';
import { SdkExecutor } from '../exec/SdkExecutor.ts';
import type { ExecHooks, StageExecutor, StageResult } from '../exec/StageExecutor.ts';
import { loadSubagents } from '../exec/subagents.ts';
import type { GatesFile } from '../gates/gatesFile.ts';
import { minimumProblems, parseGates } from '../gates/gatesFile.ts';
import { snapshotBaseline } from '../gates/builtin/index.ts';
import { runGates } from '../gates/run.ts';
import { collectVerdictInput } from '../verdict/collect.ts';
import { computeVerdict } from '../verdict/verdict.ts';
import { buildPrompt } from '../prompt/build.ts';
import { checkPreconditions, stageById, type StageContext } from './stages.ts';

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
  const rows = results.map(
    (r) =>
      `| ${r.name} | ${r.status} | ${r.command ?? 'встроенная проверка'} · код ${
        r.exitCode ?? '—'
      } · ${r.durationMs} мс |\n| | | ${r.lastLine.split('\n').join(' ')} |`,
  );
  return [
    '## Итоги автоматических гейтов (прогон рантайма, этот этап)',
    '',
    'Эти статусы получены фактическим прогоном до начала ревью. Переписывать их своим',
    'мнением нельзя: в отчёт они переносятся как есть, вердикт всё равно считается по',
    'прогону. Твоя работа — §1–§5 отчёта и поиск того, чего гейты не видят.',
    '',
    '| Гейт | Статус | Результат |',
    '|---|---|---|',
    ...rows,
  ].join('\n');
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
    return this.attempt;
  }

  /** Следующий chunk витка: нумерация попыток начинается заново. */
  nextChunk(): number {
    this.chunk += 1;
    this.attempt = 1;
    return this.chunk;
  }

  /** Набор гейтов проекта. `null` — файла нет. */
  get gatesFile(): GatesFile | null {
    const a = readArtifact(this.paths.gates);
    return a.exists ? parseGates(a.text) : null;
  }

  /** Бюджет попыток из набора гейтов, умолчание методологии — 3. */
  get attemptBudget(): number {
    const row = this.gatesFile?.rows.find((r) => /бюджет итераций/i.test(r.name));
    const m = row === undefined ? null : /(\d+)/.exec(row.implementation);
    const parsed = m === null ? NaN : Number(m[1]);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 3;
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
    throw new Error(
      `флоу «${route.flow}» ещё не реализован (этап ${stage}, маршрут ${route.modelId}). ` +
        `Собственный цикл tool-use для локальных моделей — следующий шаг.`,
    );
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

  /** Причины, по которым этап не начинается. Пустой массив — можно стартовать. */
  blockers(stage: StageId, opts: { abortHandoff?: boolean } = {}): string[] {
    const report = checkPreconditions(stageById(stage), this.ctx, opts);
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
    if (stage !== 'intent') {
      const gates = this.gatesFile;
      if (gates === null) {
        problems.push(
          `нет набора гейтов ${this.paths.gates}. Без него не определены ни «сделано», ни ` +
            `условия вердикта — виток не стартует.`,
        );
      } else {
        problems.push(...minimumProblems(gates));
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
   * «Ревью независимым агентом» — единственный такой в минимальной пятёрке: его статус
   * определяется тем, был ли субагент-рецензент вообще доступен. Отсутствие определения
   * субагента это не `✅` — это `⏭`, и он честно роняет вердикт.
   */
  private externalGateStatuses(): Record<string, GateStatus> {
    const { missing } = loadSubagents(this.config.runner.agentsDir, ['sdlc-reviewer']);
    return {
      'Ревью независимым агентом': missing.length === 0 ? '✅' : '⏭',
    };
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
      gateResults: this.lastGateResults,
      report: report.text,
      attempt: this.attempt,
      attemptBudget: this.attemptBudget,
      noProgress,
    });

    const verdict = computeVerdict(input);
    // Расхождение отчёта с прогоном — не причина падения само по себе (статус уже взят
    // по прогону), но оно обязано быть видно: рецензент, переписывающий статусы, это
    // отдельный симптом.
    const withNotes: Verdict =
      disagreements.length === 0
        ? verdict
        : { ...verdict, reasons: [...verdict.reasons, ...disagreements] };

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

    const blockers = this.blockers(stage, abortOpts);
    if (blockers.length > 0) {
      const message = blockers.join('\n');
      this.emit({ type: 'error', runId: this.id, stage, message });
      return { ok: false, finalText: '', usage: emptyUsage(), note: message };
    }

    // Один вызов предусловий на старт этапа: раньше их считали дважды, и на verify это
    // было больше мегабайта чтения с диска ради одного и того же ответа.
    const report = checkPreconditions(def, this.ctx, abortOpts);
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
    let extra = opts.extra;
    if (stage === 'verify') {
      const results = await this.runVerifyGates(this.aborter.signal);
      if (results.length > 0) {
        const block = gateReportBlock(results);
        if (opts.prompt === undefined) {
          extra = extra === undefined ? block : `${extra}\n\n${block}`;
        } else {
          // Промпт, отредактированный оператором, рантайм молча не дополняет — иначе в
          // модель ушло бы не то, что человек видел и утвердил.
          this.emit({
            type: 'warning',
            runId: this.id,
            stage,
            message:
              'промпт отредактирован оператором, поэтому итоги прогона гейтов в него не ' +
              'подклеены — рецензент их не увидит. Итоги видны в интерфейсе и учтены в вердикте.',
          });
        }
      }
    }

    // Отредактированный оператором промпт тоже уходит в шину: иначе в журнале витка
    // остаётся текст предыдущей сборки, а в модель ушёл другой.
    const prompt =
      opts.prompt ??
      this.preparePrompt(stage, {
        ...(opts.requirement === undefined ? {} : { requirement: opts.requirement }),
        ...(extra === undefined ? {} : { extra }),
      });
    if (opts.prompt !== undefined) {
      this.emit({ type: 'prompt_prepared', runId: this.id, stage, prompt });
    }

    const ctx = this.policyContext(stage);
    const executor = this.executorFor(stage);

    const hooks: ExecHooks = {
      onText: (text) => this.emit({ type: 'assistant_text', runId: this.id, stage, text }),
      onThinking: (text) => this.emit({ type: 'thinking', runId: this.id, stage, text }),

      onToolRequest: async (call, meta) => {
        this.status = 'awaiting';
        try {
          return await this.gate.request({
            runId: this.id,
            stage,
            requestId: meta.requestId,
            call,
            ctx,
          });
        } finally {
          this.status = 'running';
        }
      },

      onToolResult: (meta) =>
        this.emit({
          type: 'tool_result',
          runId: this.id,
          stage,
          requestId: meta.requestId,
          ok: meta.ok,
          summary: meta.summary,
          durationMs: meta.durationMs,
        }),

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
    if (this.attempt < 3) return false;
    const prev = readArtifact(this.paths.chunkDiff(this.chunk, this.attempt - 1));
    const before = readArtifact(this.paths.chunkDiff(this.chunk, this.attempt - 2));
    if (!prev.exists || !before.exists) return false;
    return prev.text.trim() === before.text.trim();
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
