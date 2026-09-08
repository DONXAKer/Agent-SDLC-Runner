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

import { DECISION, artifactExists, hasPlaceholder, readArtifact, readDecision } from './artifacts/artifact.ts';
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
  if (max > 0) return new Date(max).toISOString();
  // ВСЕ файлы витка пропали между readdir и stat — `max` остался нулём, и без этой ветки
  // запись показала бы дату «1970-01-01» (эпоха Unix), а не честное «дата неизвестна».
  // mtime самого каталога — не точный, но правдоподобный запасной вариант.
  try {
    return new Date(statSync(dir).mtimeMs).toISOString();
  } catch {
    return new Date(0).toISOString();
  }
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
 * Текст задачи витка для «начать похожий» — из intent.md.
 *
 * Первым берётся заголовок «# Задача: …»: в каноне формы требование стоит именно там.
 * Иначе — первая содержательная строка, и содержательной НЕ считается markdown-цитата
 * `>`: ею оформлена легенда каждого шаблона методологии, поэтому прежний фильтр (только
 * пустые строки и заголовки) выдавал у ВСЕХ витков один и тот же кусок методологии —
 * и он же подставлялся в поле задачи нового витка по клику в «Похожих витках» (ревью,
 * воспроизведено на трёх реальных intent.md).
 *
 * Длину режем: строка — подсказка для выбора, а не полный текст.
 */
const requirementCache = new Map<string, { mtimeMs: number; requirement: string | undefined }>();

function requirementExcerpt(paths: WitokPaths): string | undefined {
  // Кэш по времени правки — тем же приёмом, что у набора гейтов в `Run`: `GET /api/history`
  // сканирует ВСЕ каталоги витков проекта, и без кэша каждый заход на стартовый экран читал
  // десятки intent.md целиком синхронно, в том же цикле событий, что и поток WebSocket.
  let mtimeMs: number;
  try {
    mtimeMs = statSync(paths.intent).mtimeMs;
  } catch {
    requirementCache.delete(paths.intent);
    return undefined;
  }
  const hit = requirementCache.get(paths.intent);
  if (hit?.mtimeMs === mtimeMs) return hit.requirement;

  const intent = readArtifact(paths.intent);
  if (!intent.exists) {
    requirementCache.set(paths.intent, { mtimeMs, requirement: undefined });
    return undefined;
  }
  const lines = intent.text.split('\n').map((l) => l.trim());

  const titled = lines.find((l) => /^#{1,3}\s*Задача\s*[:—-]/i.test(l));
  const fromTitle = titled?.replace(/^#{1,3}\s*Задача\s*[:—-]\s*/i, '').trim();
  const line =
    fromTitle !== undefined && fromTitle !== '' && !hasPlaceholder(fromTitle)
      ? fromTitle
      : lines.find(
          (l) => l !== '' && !l.startsWith('#') && !l.startsWith('>') && !l.startsWith('|') && !hasPlaceholder(l),
        );
  const requirement =
    line === undefined || line === ''
      ? undefined
      : line.length > 120
        ? `${line.slice(0, 120)}…`
        : line;
  requirementCache.set(paths.intent, { mtimeMs, requirement });
  return requirement;
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
    const requirement = requirementExcerpt(paths);
    out.push({
      slug,
      status: statusOf(paths, liveSlugs.has(slug)),
      lastStage: lastStageReached(paths, files),
      updatedAt: latestMtimeIso(witokDir, files),
      // exactOptionalPropertyTypes: `requirement: undefined` в объект не подставляется.
      ...(requirement === undefined ? {} : { requirement }),
    });
  }

  out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return out;
}
