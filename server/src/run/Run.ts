/**
 * Машина витка: один прогон одного этапа за раз.
 *
 * Состояние живёт на диске, в `.sdlc/<slug>/` целевого проекта, а не в памяти процесса.
 * Поэтому предусловия проверяются чтением файлов: виток переживает перезапуск сервиса,
 * а начатый в терминале скиллами `/sdlc-*` продолжается здесь и наоборот.
 */

import { randomUUID } from 'node:crypto';

import { readArtifact } from '../artifacts/artifact.ts';
import { WitokPaths } from '../artifacts/paths.ts';
import { extractFilesToTouch } from '../artifacts/planFiles.ts';
import type { ApprovalGate } from '../approval/gate.ts';
import type { AskGate } from '../approval/askGate.ts';
import type { LoadedConfig } from '../config/load.ts';
import type { ProjectConfig, ResolvedProfile } from '../config/schema.ts';
import { SdkExecutor } from '../exec/SdkExecutor.ts';
import type { ExecHooks, StageExecutor, StageResult } from '../exec/StageExecutor.ts';
import { buildPrompt } from '../prompt/build.ts';
import { addUsage, emptyUsage } from '../types.ts';
import type { EventSink, PolicyContext, PreparedPrompt, StageId, Usage } from '../types.ts';
import { checkPreconditions, stageById, type StageContext } from './stages.ts';

export type RunStatus = 'idle' | 'running' | 'awaiting' | 'done' | 'failed';

export interface RunOptions {
  config: LoadedConfig;
  project: ProjectConfig;
  profile: ResolvedProfile;
  slug: string;
  gate: ApprovalGate;
  askGate: AskGate;
  emit: EventSink;
}

/** Этапы, после которых запись ограничена одобренным планом. */
const PLAN_SCOPED_STAGES: readonly StageId[] = ['chunk', 'verify', 'handoff'];

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

  /**
   * Список файлов, в которые разрешена запись, либо `null` — PlanScope выключен.
   *
   * Пустой список при одобренном плане — не «разрешено всё», а дефект: так PlanScope
   * выключился бы молча. Такой виток не продолжается.
   */
  planFilesFor(stage: StageId): readonly string[] | null {
    if (!PLAN_SCOPED_STAGES.includes(stage)) return null;
    const plan = readArtifact(this.paths.plan);
    if (!plan.exists) return null;
    return extractFilesToTouch(plan.text);
  }

  policyContext(stage: StageId): PolicyContext {
    return {
      projectRoot: this.project.projectRoot,
      sdlcDir: `.sdlc/${this.slug}`,
      planFiles: this.planFilesFor(stage),
      allowedTools: stageById(stage).tools,
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
  blockers(stage: StageId): string[] {
    const report = checkPreconditions(stageById(stage), this.ctx);
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

    return problems;
  }

  async runStage(
    stage: StageId,
    opts: { prompt?: PreparedPrompt; requirement?: string; extra?: string } = {},
  ): Promise<StageResult> {
    const def = stageById(stage);
    const route = this.profile.routes[stage];

    const blockers = this.blockers(stage);
    if (blockers.length > 0) {
      const message = blockers.join('\n');
      this.emit({ type: 'error', runId: this.id, stage, message });
      this.status = 'failed';
      return { ok: false, finalText: '', usage: emptyUsage(), note: message };
    }

    const report = checkPreconditions(def, this.ctx);
    if (report.skip !== null) {
      this.emit({ type: 'stage_done', runId: this.id, stage, ok: true, note: report.skip });
      return { ok: true, finalText: '', usage: emptyUsage(), note: report.skip };
    }

    this.emit({
      type: 'stage_started',
      runId: this.id,
      stage,
      flow: route.flow,
      provider: route.provider,
      model: route.model,
    });
    this.status = 'running';

    const prompt = opts.prompt ?? this.preparePrompt(stage, opts);
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

      onWarn: (message) => this.emit({ type: 'error', runId: this.id, stage, message }),
    };

    try {
      const result = await executor.run(
        {
          prompt,
          cwd: this.project.projectRoot,
          model: route.model,
          allowedTools: def.tools,
          maxTurns: this.config.runner.limits.maxIterationsPerStage,
          maxBudgetUsd: this.project.maxBudgetUsd,
        },
        hooks,
      );

      this.reportArtifacts(stage);
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
    }
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
