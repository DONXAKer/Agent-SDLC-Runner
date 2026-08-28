/**
 * Точка входа бенчмарка.
 *
 * Сейчас реализован только сухой прогон (`--dry-run`): он готовит рабочую копию, поднимает
 * настоящий `Run` и печатает блокеры всех семи этапов, ни разу не обратившись к модели.
 * Это самый дешёвый способ поймать то, что ломает виток до всякой модели — несобранный
 * набор гейтов, несовпавшую ветку, отсутствующий эталон методологии.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { STAGE_ORDER } from '@sdlc-runner/shared';
import type { RunEvent, StageId } from '@sdlc-runner/shared';

import { AskGate } from '../../server/src/approval/askGate.ts';
import { ApprovalGate } from '../../server/src/approval/gate.ts';
import { loadConfig } from '../../server/src/config/load.ts';
import { ProfileError } from '../../server/src/config/profiles.ts';
import type { LoadedConfig } from '../../server/src/config/load.ts';
import { Run } from '../../server/src/run/Run.ts';
import { OptionsError, USAGE, parseArgs } from './options.ts';
import type { BenchOptions } from './options.ts';
import { ControlError, buildProfile, readControl } from './profile.ts';
import { WorkspaceError, prepareWorkspace } from './workspace.ts';

const BENCH_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_DIR = join(BENCH_DIR, 'fixture');
const CONTROL_FILE = join(BENCH_DIR, 'control.json');

/**
 * Ветка витка берётся из текста задачи, а не из отдельной настройки.
 *
 * Задача называет ветку модели, и `intent.md` обязан её повторить; если бы имя жило в двух
 * местах, они разъехались бы, и виток встал бы на сверке ветки по нашей вине, а не по вине
 * модели.
 */
function branchFromTask(taskPath: string): string {
  const text = readFileSync(taskPath, 'utf8');
  const m = /`(sdlc\/[\w.\/-]+)`/.exec(text);
  if (m === null) throw new WorkspaceError(`${taskPath}: в тексте задачи не названа ветка витка вида \`sdlc/…\``);
  return m[1]!;
}

/** Конфиг машины с наложением того, что бенчмарк обязан задать сам. */
function benchConfig(base: LoadedConfig, opts: BenchOptions): LoadedConfig {
  return {
    ...base,
    runner: {
      ...base.runner,
      // Имя оператора уходит в поля решений артефактов. «Бенчмарк» там стоит намеренно:
      // виток, подписанный автоответчиком, не должен читаться как виток, принятый человеком.
      operator: 'Бенчмарк',
      limits: { ...base.runner.limits, maxIterationsPerStage: opts.maxIterationsPerStage },
    },
  };
}

async function dryRun(opts: BenchOptions): Promise<number> {
  const base = loadConfig();
  const config = benchConfig(base, opts);
  const control = readControl(CONTROL_FILE);
  const branch = branchFromTask(join(FIXTURE_DIR, 'task.md'));

  const ws = await prepareWorkspace({ fixtureDir: FIXTURE_DIR, slug: opts.slug, branch });
  console.log(`рабочая копия: ${ws.root}`);
  console.log(`ветка витка:   ${ws.branch} (база ${ws.baseCommit.slice(0, 8)})`);

  const built = buildProfile({
    projectRoot: ws.root,
    models: config.models,
    control,
    opts,
  });
  console.log(`профиль:       ${built.profile.label}`);
  for (const stage of STAGE_ORDER) {
    const measured = built.measured.includes(stage);
    console.log(`  ${measured ? '→' : ' '} ${stage.padEnd(8)} ${built.routes[stage]}${measured ? '   (под измерением)' : ''}`);
  }

  const events: RunEvent[] = [];
  const run = new Run({
    config,
    project: built.project,
    profile: built.profile,
    slug: opts.slug,
    gate: new ApprovalGate({ onPending: () => {}, onResolved: () => {} }),
    askGate: new AskGate({ onPending: () => {}, onAnswered: () => {} }),
    emit: (e) => events.push(e),
  });

  console.log('\nблокеры этапов (модель не вызывалась):');
  let blockedStages = 0;
  try {
    for (const stage of STAGE_ORDER as readonly StageId[]) {
      const problems = run.blockers(stage);
      if (problems.length === 0) {
        console.log(`  ${stage.padEnd(8)} — путь свободен`);
        continue;
      }
      blockedStages += 1;
      console.log(`  ${stage.padEnd(8)} — ${problems.length}:`);
      for (const p of problems) console.log(`      ${p}`);
    }
  } finally {
    await run.dispose();
    if (opts.keepWorkspace) console.log(`\nрабочая копия оставлена: ${ws.root}`);
    else ws.dispose();
  }

  // Блокеры на поздних этапах — норма: их снимают артефакты, которых на сухом прогоне ещё
  // нет. Значим ровно один этап: до `intent` виток обязан доходить без единого блокера.
  const intentBlocked = run.blockers('intent').length > 0;
  console.log(
    intentBlocked
      ? '\nсухой прогон КРАСНЫЙ: этап 1 заблокирован — до модели дело не дойдёт'
      : `\nсухой прогон зелёный: этап 1 открыт, заблокированных этапов дальше — ${blockedStages}`,
  );
  return intentBlocked ? 2 : 0;
}

export async function main(argv: readonly string[]): Promise<number> {
  let opts: BenchOptions;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    if (e instanceof OptionsError) {
      console.error(`${e.message}\n\n${USAGE}`);
      return 2;
    }
    throw e;
  }

  try {
    if (opts.dryRun) return await dryRun(opts);
    console.error('живой прогон ещё не реализован — доступен только --dry-run');
    return 2;
  } catch (e) {
    // Три причины «измерение не состоялось» называются отдельно: у каждой свой способ
    // починки, и слив их в один текст стоил бы времени на следующем прогоне.
    if (e instanceof ProfileError) {
      console.error(`профиль не собрался:\n  ${e.problems.join('\n  ')}`);
      return 2;
    }
    if (e instanceof ControlError || e instanceof WorkspaceError) {
      console.error(`подготовка не удалась: ${e.message}`);
      return 2;
    }
    throw e;
  }
}

const code = await main(process.argv.slice(2));
process.exit(code);
