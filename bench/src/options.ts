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

/**
 * Задачи фикстуры `parcel-price` — по имени собираются пути `task-<task>.md`,
 * `human-<task>.json`, `<task>.hidden.mjs` (кроме `oversize`, у неё имена без суффикса по
 * историческим причинам — первая задача, заведена раньше многозадачности).
 */
export const TASKS = ['oversize', 'freeship'] as const;
export type Task = (typeof TASKS)[number];

export interface BenchOptions {
  mode: BenchMode;
  /** Измеряемая модель — id из `config/models.json`. */
  model: string;
  /** Какая задача фикстуры измеряется — щупы и ловушки у задач разные (см. `TASKS`). */
  task: Task;
  slug: string;
  /** Точечная замена контрольного маршрута: `--control-chunk=<id>`. */
  controlOverrides: Partial<Record<StageId, string>>;
  stageTimeoutMs: number;
  runTimeoutMs: number;
  maxIterationsPerStage: number;
  /**
   * Потолок стоимости витка.
   *
   * Ноль сюда попасть не может, и это не придирка: проверка исполнителя написана как
   * `потрачено >= потолок`, поэтому бюджет 0 исчерпан ещё до первого хода, и каждый этап
   * флоу `loop` обрывался бы с «бюджет прогона исчерпан: $0.0000 из $0». На локальных
   * провайдерах `costUsd` приходит null, и бюджет не действует вообще — ограничителями
   * остаются ходы и стенные часы.
   */
  maxBudgetUsd: number;
  attempts: number;
  keepWorkspace: boolean;
  /** Готовит рабочую копию и печатает блокеры, не вызывая модель ни разу. */
  dryRun: boolean;
  /**
   * Преполётная проба tool-calling вместо витка: три микро-кейса за секунды, без рабочей
   * копии. Скрининг перед дорогим замером — см. `probe.ts`.
   */
  probe: boolean;
  /**
   * Имя снимка (шаг 6 ROADMAP.md), который сделать сразу после успешного `plan` этого
   * прогона, вместо того чтобы идти дальше к `chunk`. Прогон останавливается на снимке —
   * это отдельный режим, не довесок к измерению.
   */
  makeSnapshot: string | null;
  /**
   * Имя снимка, с которого восстановить рабочую копию вместо прохода этапов с начала.
   * Точка снимка хранится в нём самом (`stoppedAfterStage`) — driver стартует со
   * СЛЕДУЮЩЕГО за ней этапа независимо от `--stage`/`--all`: пройденные этапы снимок
   * уже содержит побайтово.
   */
  fromSnapshot: string | null;
  /**
   * Число прогонов серии одной командой (`--repeat`). Правило журнала «для 8B — серии ≥3»
   * было дисциплиной, а не механикой: серии гонялись циклом руками, и половина сравнений
   * держалась на единственном сэмпле. Каждый сэмпл получает слаг `<slug>-sN` и свой отчёт;
   * сводка серии — медиана и разброс по щупам.
   */
  repeat: number;
  /**
   * После какого этапа делать снимок (`--make-snapshot`). Умолчание `plan` — прежнее
   * поведение; `intent`/`explore`/… дают дешёвый замер ЛЮБОГО этапа в изоляции, а не
   * только chunk'а (шаг «снимки на каждый этап» из анализа порогов слабых моделей).
   */
  snapshotAfter: StageId;
}

export class OptionsError extends Error {}

const DEFAULTS = {
  stageTimeoutMs: 30 * 60_000,
  runTimeoutMs: 3 * 60 * 60_000,
  // Ниже штатных 40: застрявшая модель сжигает бюджет попыток по целому этапу каждая.
  maxIterationsPerStage: 25,
  // Виток целиком с рецензентом на opus. Ноль запрещён — см. BenchOptions.maxBudgetUsd.
  maxBudgetUsd: 5,
  attempts: 3,
};

export const USAGE = `
Бенчмарк моделей на фикстурном витке.

  npm run bench -- --model <id> (--stage <этап> | --all) [ключи]

  --model <id>          измеряемая модель, id из config/models.json
  --task <имя>          задача фикстуры (умолчание oversize): ${TASKS.join('|')}
  --stage <этап>        измерять один этап: intent|explore|ask|plan|chunk|verify|handoff
  --all                 измерять все этапы, КРОМЕ verify (правило рецензента)
  --slug <имя>          слаг витка (умолчание: bench-<модель>-<режим>)
  --control-<этап> <id> заменить контрольный маршрут этапа
  --stage-timeout <мин> потолок стенных часов на этап (умолчание 30)
  --run-timeout <мин>   потолок на весь виток (умолчание 180)
  --max-turns <n>       ходов на этап (умолчание 25)
  --budget <usd>        бюджет витка (умолчание 5); на локальных провайдерах НЕ действует
  --attempts <n>        потолок повторов chunk↔verify (умолчание 3)
  --repeat <n>          серия из n одинаковых прогонов (слаги <slug>-s1…-sn, сводка с медианой)
  --keep-workspace      не удалять рабочую копию в tmp
  --dry-run             подготовить копию и напечатать блокеры, модель не вызывать
  --probe               преполётная проба tool-calling: 3 микро-кейса за секунды, без витка
  --make-snapshot <имя> остановиться после точки снимка и сохранить снимок под этим именем
  --snapshot-after <этап> точка снимка для --make-snapshot (умолчание plan)
  --from-snapshot <имя> начать с этого снимка — со следующего этапа после его точки
`.trimStart();

function isStageId(v: string): v is StageId {
  return (STAGE_ORDER as readonly string[]).includes(v);
}

function isTask(v: string): v is Task {
  return (TASKS as readonly string[]).includes(v);
}

function positiveNumber(raw: string, what: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new OptionsError(`${what}: ожидалось число больше нуля, получено «${raw}»`);
  return n;
}

export function parseArgs(argv: readonly string[]): BenchOptions {
  let mode: BenchMode | null = null;
  let model: string | null = null;
  let task: Task = 'oversize';
  let slug: string | null = null;
  const controlOverrides: Partial<Record<StageId, string>> = {};
  let stageTimeoutMs = DEFAULTS.stageTimeoutMs;
  let runTimeoutMs = DEFAULTS.runTimeoutMs;
  let maxIterationsPerStage = DEFAULTS.maxIterationsPerStage;
  let maxBudgetUsd = DEFAULTS.maxBudgetUsd;
  let attempts = DEFAULTS.attempts;
  let repeat = 1;
  let keepWorkspace = false;
  let dryRun = false;
  let probe = false;
  let makeSnapshot: string | null = null;
  let fromSnapshot: string | null = null;
  // `null` — ключ не задан; умолчание `plan` подставляется на выходе. Один факт в одной
  // переменной, а не значение + флаг-спутник, которые разъезжаются при правке разбора.
  let snapshotAfter: StageId | null = null;

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
      case '--task': {
        const t = next(i, key);
        if (!isTask(t)) throw new OptionsError(`неизвестная задача «${t}»; допустимы: ${TASKS.join(', ')}`);
        task = t;
        i++;
        break;
      }
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
      case '--repeat':
        repeat = Math.floor(positiveNumber(next(i, key), key));
        i++;
        break;
      case '--keep-workspace':
        keepWorkspace = true;
        break;
      case '--dry-run':
        dryRun = true;
        break;
      case '--probe':
        probe = true;
        break;
      case '--make-snapshot':
        makeSnapshot = next(i, key);
        i++;
        break;
      case '--snapshot-after': {
        const stage = next(i, key);
        if (!isStageId(stage)) {
          throw new OptionsError(`неизвестный этап «${stage}» в ${key}; допустимы: ${STAGE_ORDER.join(', ')}`);
        }
        if (stage === 'handoff') {
          throw new OptionsError('снимок после handoff бессмыслен: этапа после него нет, мерить со снимка нечего');
        }
        snapshotAfter = stage;
        i++;
        break;
      }
      case '--from-snapshot':
        fromSnapshot = next(i, key);
        i++;
        break;
      default:
        throw new OptionsError(`неизвестный ключ «${key}»`);
    }
  }

  // На сухом прогоне модель не вызывается ни разу, и требовать её значило бы просить назвать
  // то, что не будет использовано.
  if (model === null && !dryRun) throw new OptionsError('не задана измеряемая модель: --model <id>');
  // Пробе не нужен режим: она вообще не запускает виток.
  if (mode === null && !dryRun && !probe) throw new OptionsError('не задан режим: --stage <этап> либо --all');
  // Комбинация режимов — почти наверняка опечатка: молча выигравшая проба выглядела бы
  // как «сухой прогон ничего не нашёл».
  if (probe && dryRun) throw new OptionsError('--probe и --dry-run взаимоисключающие');
  // Читать один снимок и писать ДРУГОЙ — законно и полезно: «снимок после chunk» дешевле
  // всего снимается от уже существующего «после plan», без повторной оплаты этапов 1–4
  // (живой прогон --all ради этого сгорел на условном ask — модель решила «спрашивать
  // нечего» и не записала отчёт). Запрещён только один и тот же слот в обе стороны.
  if (makeSnapshot !== null && makeSnapshot === fromSnapshot) {
    throw new OptionsError('--make-snapshot и --from-snapshot указывают на один слот: снимок затёр бы сам себя');
  }
  // Серия — про измерение дисперсии; проба и сухой прогон детерминированы по нашей
  // стороне, а n одинаковых снимков затирали бы друг друга одним именем.
  if (repeat > 1 && (probe || dryRun || makeSnapshot !== null)) {
    throw new OptionsError('--repeat совместим только с живым измерением (--stage/--all без --make-snapshot)');
  }
  // Точка снимка без самого снимка — почти наверняка опечатка в наборе ключей, и молчаливое
  // игнорирование стоило бы платного прогона, который остановился не там, где ждали.
  if (snapshotAfter !== null && makeSnapshot === null) {
    throw new OptionsError('--snapshot-after имеет смысл только вместе с --make-snapshot');
  }

  const resolvedMode: BenchMode = mode ?? { kind: 'all' };
  const resolvedModel = model ?? '';
  const modeTag = resolvedMode.kind === 'all' ? 'all' : resolvedMode.stage;

  return {
    mode: resolvedMode,
    model: resolvedModel,
    task,
    slug: slug ?? `bench-${task}-${(resolvedModel || 'dry').replace(/[^\w.-]+/g, '-')}-${modeTag}`,
    controlOverrides,
    stageTimeoutMs,
    runTimeoutMs,
    maxIterationsPerStage,
    maxBudgetUsd,
    attempts,
    repeat,
    keepWorkspace,
    dryRun,
    probe,
    makeSnapshot,
    fromSnapshot,
    snapshotAfter: snapshotAfter ?? 'plan',
  };
}
