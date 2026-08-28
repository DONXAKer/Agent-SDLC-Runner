/**
 * Разбор аргументов. Без I/O — чтобы проверяться тестом без файловой системы.
 */

import { STAGE_ORDER } from '@sdlc-runner/shared';
import type { StageId } from '@sdlc-runner/shared';

export type BenchMode =
  /** Измеряемая модель на одном этапе, остальные — контрольный маршрут. */
  | { kind: 'stage'; stage: StageId }
  /**
   * Измеряемая модель на всех этапах, КРОМЕ verify.
   *
   * Не «на всём витке»: правило рецензента требует строго `rank(verify) > rank(chunk)`,
   * поэтому этап 6 всегда идёт по контрольному маршруту. Называть это «вся модель на
   * витке» значило бы отчитаться о том, чего не было.
   */
  | { kind: 'all' };

export interface BenchOptions {
  mode: BenchMode;
  /** Измеряемая модель — id из `config/models.json`. */
  model: string;
  slug: string;
  /** Точечная замена контрольного маршрута: `--control-chunk=<id>`. */
  controlOverrides: Partial<Record<StageId, string>>;
  stageTimeoutMs: number;
  runTimeoutMs: number;
  maxIterationsPerStage: number;
  maxBudgetUsd: number | null;
  attempts: number;
  keepWorkspace: boolean;
  /** Готовит рабочую копию и печатает блокеры, не вызывая модель ни разу. */
  dryRun: boolean;
}

export class OptionsError extends Error {}

const DEFAULTS = {
  stageTimeoutMs: 30 * 60_000,
  runTimeoutMs: 3 * 60 * 60_000,
  // Ниже штатных 40: застрявшая модель сжигает бюджет попыток по целому этапу каждая.
  maxIterationsPerStage: 25,
  attempts: 3,
};

export const USAGE = `
Бенчмарк моделей на фикстурном витке.

  npm run bench -- --model <id> (--stage <этап> | --all) [ключи]

  --model <id>          измеряемая модель, id из config/models.json
  --stage <этап>        измерять один этап: intent|explore|ask|plan|chunk|verify|handoff
  --all                 измерять все этапы, КРОМЕ verify (правило рецензента)
  --slug <имя>          слаг витка (умолчание: bench-<модель>-<режим>)
  --control-<этап> <id> заменить контрольный маршрут этапа
  --stage-timeout <мин> потолок стенных часов на этап (умолчание 30)
  --run-timeout <мин>   потолок на весь виток (умолчание 180)
  --max-turns <n>       ходов на этап (умолчание 25)
  --budget <usd>        бюджет витка; на локальных провайдерах НЕ действует
  --attempts <n>        потолок повторов chunk↔verify (умолчание 3)
  --keep-workspace      не удалять рабочую копию в tmp
  --dry-run             подготовить копию и напечатать блокеры, модель не вызывать
`.trimStart();

function isStageId(v: string): v is StageId {
  return (STAGE_ORDER as readonly string[]).includes(v);
}

function positiveNumber(raw: string, what: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new OptionsError(`${what}: ожидалось число больше нуля, получено «${raw}»`);
  return n;
}

export function parseArgs(argv: readonly string[]): BenchOptions {
  let mode: BenchMode | null = null;
  let model: string | null = null;
  let slug: string | null = null;
  const controlOverrides: Partial<Record<StageId, string>> = {};
  let stageTimeoutMs = DEFAULTS.stageTimeoutMs;
  let runTimeoutMs = DEFAULTS.runTimeoutMs;
  let maxIterationsPerStage = DEFAULTS.maxIterationsPerStage;
  let maxBudgetUsd: number | null = null;
  let attempts = DEFAULTS.attempts;
  let keepWorkspace = false;
  let dryRun = false;

  const next = (i: number, key: string): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new OptionsError(`ключу ${key} нужно значение`);
    return v;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    // `--ключ=значение` приводится к паре: обе формы обычны, и требовать одну — лишнее трение.
    const eq = arg.indexOf('=');
    if (arg.startsWith('--') && eq > 2) {
      argv = [...argv.slice(0, i), arg.slice(0, eq), arg.slice(eq + 1), ...argv.slice(i + 1)];
    }
    const key = argv[i]!;

    const control = /^--control-(.+)$/.exec(key);
    if (control !== null) {
      const stage = control[1]!;
      if (!isStageId(stage)) throw new OptionsError(`неизвестный этап в ${key}`);
      controlOverrides[stage] = next(i, key);
      i++;
      continue;
    }

    switch (key) {
      case '--model':
        model = next(i, key);
        i++;
        break;
      case '--stage': {
        const stage = next(i, key);
        if (!isStageId(stage)) {
          throw new OptionsError(`неизвестный этап «${stage}»; допустимы: ${STAGE_ORDER.join(', ')}`);
        }
        mode = { kind: 'stage', stage };
        i++;
        break;
      }
      case '--all':
        mode = { kind: 'all' };
        break;
      case '--slug':
        slug = next(i, key);
        i++;
        break;
      case '--stage-timeout':
        stageTimeoutMs = positiveNumber(next(i, key), key) * 60_000;
        i++;
        break;
      case '--run-timeout':
        runTimeoutMs = positiveNumber(next(i, key), key) * 60_000;
        i++;
        break;
      case '--max-turns':
        maxIterationsPerStage = positiveNumber(next(i, key), key);
        i++;
        break;
      case '--budget':
        maxBudgetUsd = positiveNumber(next(i, key), key);
        i++;
        break;
      case '--attempts':
        attempts = positiveNumber(next(i, key), key);
        i++;
        break;
      case '--keep-workspace':
        keepWorkspace = true;
        break;
      case '--dry-run':
        dryRun = true;
        break;
      default:
        throw new OptionsError(`неизвестный ключ «${key}»`);
    }
  }

  // На сухом прогоне модель не вызывается ни разу, и требовать её значило бы просить назвать
  // то, что не будет использовано.
  if (model === null && !dryRun) throw new OptionsError('не задана измеряемая модель: --model <id>');
  if (mode === null && !dryRun) throw new OptionsError('не задан режим: --stage <этап> либо --all');

  const resolvedMode: BenchMode = mode ?? { kind: 'all' };
  const resolvedModel = model ?? '';
  const modeTag = resolvedMode.kind === 'all' ? 'all' : resolvedMode.stage;

  return {
    mode: resolvedMode,
    model: resolvedModel,
    slug: slug ?? `bench-${(resolvedModel || 'dry').replace(/[^\w.-]+/g, '-')}-${modeTag}`,
    controlOverrides,
    stageTimeoutMs,
    runTimeoutMs,
    maxIterationsPerStage,
    maxBudgetUsd,
    attempts,
    keepWorkspace,
    dryRun,
  };
}
