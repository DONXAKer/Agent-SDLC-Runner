/**
 * История витков проекта — читается с диска, а не из памяти живых прогонов.
 *
 * `runs` (Map в index.ts) хранит только то, что сервер запускал сам с момента своего
 * старта; список опустошается перезапуском. Артефакты витка в `.sdlc/<slug>/` при этом
 * никуда не деваются — эта функция сканирует их и классифицирует по тому же полю
 * «Приёмка», по которому предусловие этапа `handoff` решает, принят ли виток.
 */

import type { Dirent } from 'node:fs';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { HistoryEntry, HistoryStatus, StageId } from '@sdlc-runner/shared';

import { DECISION, artifactExists, readArtifact, readDecision } from './artifacts/artifact.ts';
import { SDLC_DIR, WitokPaths } from './artifacts/paths.ts';

/**
 * Самый дальний этап, до которого дошёл виток, — по факту наличия артефакта, а не по
 * chunk/attempt (их для чужого, не запущенного здесь витка взять неоткуда дёшево).
 * Порядок от позднего к раннему: первый найденный артефакт и есть ответ.
 */
function lastStageReached(paths: WitokPaths, files: readonly string[]): StageId | null {
  if (artifactExists(paths.handoff)) return 'handoff';
  if (files.some((f) => f.startsWith('verification-report-'))) return 'verify';
  if (files.some((f) => /^chunk-\d+-journal\.md$/.test(f))) return 'chunk';
  if (artifactExists(paths.plan)) return 'plan';
  if (artifactExists(paths.clarificationReport)) return 'ask';
  if (artifactExists(paths.explorationReport)) return 'explore';
  if (artifactExists(paths.intent)) return 'intent';
  return null;
}

function latestMtimeIso(dir: string, files: readonly string[]): string {
  let max = 0;
  for (const f of files) {
    try {
      const t = statSync(join(dir, f)).mtimeMs;
      if (t > max) max = t;
    } catch {
      // Файл мог исчезнуть между readdir и stat — не роняем сканирование ради одной строки.
    }
  }
  return new Date(max).toISOString();
}

function statusOf(paths: WitokPaths, isLive: boolean): HistoryStatus {
  const handoff = readArtifact(paths.handoff);
  if (handoff.exists) {
    const d = readDecision(handoff.text, DECISION.accepted);
    if (d.state === 'granted') return 'done';
    if (d.state === 'declined') return 'aborted';
  }
  return isLive ? 'open' : 'unfinished';
}

/**
 * `liveSlugs` — слаги витков этого же проекта, которые сервер сейчас держит в памяти;
 * без этого различить «виток идёт прямо сейчас» и «брошен без записи давно» по одним
 * файлам на диске нечем — оба состояния выглядят одинаково.
 */
export function scanHistory(projectRoot: string, liveSlugs: ReadonlySet<string>): HistoryEntry[] {
  const dir = join(projectRoot, SDLC_DIR);
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const out: HistoryEntry[] = [];
  for (const e of entries) {
    // `gates.md`/`seed-log.md` — файлы проекта, не каталоги витков.
    if (!e.isDirectory()) continue;
    const slug = e.name;
    const witokDir = join(dir, slug);
    let files: string[];
    try {
      files = readdirSync(witokDir);
    } catch {
      continue;
    }
    if (files.length === 0) continue;

    const paths = new WitokPaths(projectRoot, slug);
    out.push({
      slug,
      status: statusOf(paths, liveSlugs.has(slug)),
      lastStage: lastStageReached(paths, files),
      updatedAt: latestMtimeIso(witokDir, files),
    });
  }

  out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return out;
}
