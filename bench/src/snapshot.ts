/**
 * Снимки рабочей копии (шаг 6 ROADMAP.md).
 *
 * Состояние снимается после точки, названной `--snapshot-after` (умолчание — `plan`),
 * и прогон со снимка стартует со СЛЕДУЮЩЕГО за ней этапа: пройденные этапы не
 * оплачиваются повторно, и — важнее экономии — все модели получают побайтово одинаковый
 * вход. Так замеряется в изоляции любой этап, не только chunk. Снимок — полная копия рабочей копии
 * (рабочее дерево, `.git`, `.sdlc/<slug>/`), не диф и не архив: восстановление обязано
 * дать то же самое дерево, каким его увидел бы следующий этап живого прогона.
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { StageId } from '@sdlc-runner/shared';

import { git } from '../../server/src/gates/git.ts';
import { SDLC_DIR, WitokPaths } from '../../server/src/artifacts/paths.ts';

/**
 * Лента событий прогона в снимок не входит.
 *
 * Снимок — состояние ВИТКА (дерево, git, артефакты), а не история прогона, который его
 * сделал. Пока лента копировалась вместе с остальным, каждый прогон со снимка дописывал
 * свои события в чужой файл, и `readPersistedEvents` (она фильтра по прогону не имеет)
 * отдавала щупам смесь двух прогонов. Бьёт это в сторону ЛОЖНОГО ЗЕЛЁНОГО: щуп честности
 * `journalClaimsVsBash` подтверждает утверждение журнала успешным вызовом `bash` из
 * ленты — и вызов ПРЕДЫДУЩЕГО прогона годился ему так же, как свой.
 *
 * Тот же класс, что протечка `snapshot.json` в рабочую копию (r18): чужой метафайл
 * снимка портит замер, а выглядит это как поведение измеряемой модели.
 */
function dropEventLog(root: string, slug: string): void {
  rmSync(new WitokPaths(root, slug).events, { force: true });
}

export class SnapshotError extends Error {}

export interface SnapshotMeta {
  /** Слаг витка контрольного прогона, с которого снят снимок. */
  slug: string;
  branch: string;
  /** Этап, после которого сделан снимок — дальше начинает `--from-snapshot`. */
  stoppedAfterStage: StageId;
  createdAt: string;
  /**
   * Задача (`--task`), для которой снят снимок. Без неё снимок `vat-rounding-plan` под
   * `--task oversize` (умолчание ключа!) восстанавливался молча: дерево — от billing, а
   * банк ответов, текст задачи и скрытый тест — от oversize; все кейсы красные при
   * исправной модели, и по отчёту это неотличимо от провала. Поле обязательное: снимки
   * машинно-специфичны и не версионируются, снятые до поля дописываются одной строкой в
   * `snapshot.json` — ошибка называет её; «принять под честное слово `--task`» было бы тем
   * же молчаливым прогоном, только с предупреждением, которое в серии `--repeat` тонет.
   */
  task: string;
}

function metaPath(dir: string): string {
  return join(dir, 'snapshot.json');
}

/**
 * Снимает рабочую копию целиком в `<snapshotsDir>/<name>/`. Прежний снимок под тем же
 * именем стирается — имя это слот, а не история версий: история — дело git, не бенчмарка.
 */
export function makeSnapshot(args: {
  workspaceRoot: string;
  snapshotsDir: string;
  name: string;
  slug: string;
  branch: string;
  stoppedAfterStage: StageId;
  task: string;
}): void {
  const dest = join(args.snapshotsDir, args.name);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(args.snapshotsDir, { recursive: true });
  cpSync(args.workspaceRoot, dest, { recursive: true });

  dropEventLog(dest, args.slug);

  const meta: SnapshotMeta = {
    slug: args.slug,
    branch: args.branch,
    stoppedAfterStage: args.stoppedAfterStage,
    createdAt: new Date().toISOString(),
    task: args.task,
  };
  writeFileSync(metaPath(dest), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
}

export interface RestoredSnapshot {
  root: string;
  slug: string;
  branch: string;
  stoppedAfterStage: StageId;
  dispose(): void;
}

/**
 * Восстанавливает снимок в свежий каталог tmp — снимок сам остаётся нетронутым, чтобы
 * им могли независимо воспользоваться несколько прогонов подряд (разные модели на одном
 * и том же побайтово одинаковом входе).
 *
 * `targetSlug` обязателен, когда он отличается от слага, под которым снимок сделан:
 * артефакты витка лежат на диске под `.sdlc/<слаг>/` (`WitokPaths`), и новый прогон со
 * своим слагом искал бы `plan.md` там, где его нет — блокер «нет файла» на первом же
 * этапе, ДО единого вызова модели, неотличимый по виду от честного результата (поймано
 * первым же живым прогоном со снимка: `bench-local-qwen` «провалил» chunk, ни разу не
 * дойдя до модели). Каталог `.sdlc/<исходный слаг>/` переименовывается в
 * `.sdlc/<targetSlug>/` внутри копии — снимка это не касается, копия одноразовая.
 */
export function restoreSnapshot(args: {
  snapshotsDir: string;
  name: string;
  targetSlug: string;
  /** Задача прогона (`--task`): снимок чужой задачи отвергается ДО копирования дерева. */
  expectedTask: string;
}): RestoredSnapshot {
  const src = join(args.snapshotsDir, args.name);
  if (!existsSync(src)) {
    throw new SnapshotError(`снимка «${args.name}» нет в ${args.snapshotsDir}`);
  }
  const metaFile = metaPath(src);
  if (!existsSync(metaFile)) {
    throw new SnapshotError(`${src}: нет snapshot.json — это не снимок бенчмарка`);
  }
  const meta = JSON.parse(readFileSync(metaFile, 'utf8')) as Partial<SnapshotMeta> & SnapshotMeta;
  if (typeof meta.task !== 'string' || meta.task === '') {
    throw new SnapshotError(
      `снимок «${args.name}» снят до появления поля task, принадлежность задаче сверить нечем — ` +
        `допиши в ${metaFile} строку "task": "<id задачи, для которой снимался>" и повтори`,
    );
  }
  if (meta.task !== args.expectedTask) {
    throw new SnapshotError(
      `снимок «${args.name}» снят для задачи «${meta.task}», прогон запрошен для «${args.expectedTask}» — ` +
        'банк ответов и скрытые тесты не совпали бы с деревом; укажи --task ' + meta.task,
    );
  }

  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sdlc-bench-snap-')));
  try {
    cpSync(src, root, { recursive: true });
    // Метафайл снимка — принадлежность БЕНЧМАРКА, и в рабочей копии ему не место:
    // untracked `snapshot.json` в корне проекта роняет гейт «Scope: файлы вне плана»
    // (и «нетракованные файлы») на каждом прогоне со снимка — красный вердикт по scope,
    // который выглядел как дефект измеряемой модели. Пойман сравнением двух ревью r18:
    // оба рецензента, независимо, назвали виновником именно его.
    rmSync(metaPath(root), { force: true });
    // Снимки, снятые до этой правки, ленту всё ещё содержат — чистим и на восстановлении.
    dropEventLog(root, meta.slug);
    if (args.targetSlug !== meta.slug) {
      const from = join(root, SDLC_DIR, meta.slug);
      const to = join(root, SDLC_DIR, args.targetSlug);
      if (existsSync(from)) renameSync(from, to);
    }
    return {
      root,
      slug: args.targetSlug,
      branch: meta.branch,
      stoppedAfterStage: meta.stoppedAfterStage,
      dispose: () => rmSync(root, { recursive: true, force: true }),
    };
  } catch (e) {
    rmSync(root, { recursive: true, force: true });
    throw e;
  }
}

/**
 * Ветка восстановленного снимка — обязана совпасть с текущей веткой дерева. Снимок берёт
 * рабочую копию как есть, но `git` не гарантирует, что checkout переживает `cp` байт в
 * байт на всех платформах (symlink `.git/HEAD` в некоторых конфигурациях) — дешёвая
 * перепроверка дешевле, чем непонятный `branchMismatchBlocker` посреди чужого этапа.
 */
export async function verifyRestoredBranch(root: string, expected: string): Promise<void> {
  const r = await git(['rev-parse', '--abbrev-ref', 'HEAD'], root);
  const actual = r.stdout.trim();
  if (actual !== expected) {
    throw new SnapshotError(`восстановленный снимок на ветке «${actual}», ожидалась «${expected}»`);
  }
}
