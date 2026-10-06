/**
 * Вердикт попытки — состояние РАНТАЙМА, и лежит оно вне проекта:
 * `<SDLC_STATE_DIR или ~/.sdlc-runner>/verdicts/<проект>/<слаг>/chunk-N-attempt-K.json`.
 *
 * Единственный источник «попытка принята» для handoff (коммит!), предусловия chunk,
 * `/advance` и восстановления после рестарта. Прежде источником была строка `passed:`
 * отчёта приёмки — а отчёт пишет и модель этапа 6: `- passed: true`, записанный моделью до
 * отмены этапа, открывал handoff с коммитом непроверенного витка. Затем — файл в каталоге
 * витка, закрытый политикой только от Write/Edit и редиректов: `cp`/`mv` лексер не видит
 * сознательно, и копия чужого вердикта читалась как настоящая; подпись HMAC это закрывала,
 * но принесла ключ, который терялся с контейнером, гонку его создания и запреты по имени
 * файла, бившие по проектам (code-review-all 2026-09-23). Вне проекта файл недосягаем для
 * инструментов модели по построению: `pathScope` не пускает туда ни чтение, ни запись, а
 * путь зависит от корня проекта, которого у модели в Bash нет в виде этого ключа.
 *
 * Цена: вердикт привязан к машине и к пути проекта. Витки, начатые до этой раскладки,
 * должны повторить verify; от перезаписи улик их попытку бережёт `attemptJudgedInLog`.
 * Секция «Вердикт» отчёта приёмки остаётся копией для человека и терминальных скиллов.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import type { Verdict, VerdictAction } from '@sdlc-runner/shared';

import { readArtifact } from '../artifacts/artifact.ts';
import type { WitokPaths } from '../artifacts/paths.ts';
import { SDLC_CONSTANTS, assertSameList } from '../config/constants.ts';
import { parseIterations, readIterationsText } from './iterationsLog.ts';

const ACTIONS: readonly VerdictAction[] = ['continue', 'retry', 'escalate', 'blocked_env'];
// Словарь `action` — из `sdlc-constants.json`; порядок там свой, сравнивается множество.
assertSameList('словарь action (actions)', [...ACTIONS].sort(), [...SDLC_CONSTANTS.actions].sort());

/** Вердикт с тем, к чему он относится, и что с ним уже сделано. */
export interface StoredVerdict extends Verdict {
  /** Хеш патча попытки на момент расчёта; `null` — патча не было. */
  patchSha: string | null;
  /** sha локального коммита handoff по этой попытке; `null` — коммита ещё не было. */
  committedSha: string | null;
}

/** Каталог состояния рантайма этой машины (`SDLC_STATE_DIR`, иначе `~/.sdlc-runner`). */
export function runtimeStateDir(): string {
  const dir = process.env['SDLC_STATE_DIR'];
  return dir !== undefined && dir !== '' ? dir : join(homedir(), '.sdlc-runner');
}

/**
 * Канонический корень проекта: абсолютный, с прямыми слэшами, на Windows без различия
 * регистра. Ключ вердиктов этой машины и ключ, по которому дашборд сводит несколько имён
 * конфига с одним корнем в один проект (витки на диске у них одни).
 */
export function canonicalRoot(projectRoot: string): string {
  const root = resolve(projectRoot).replace(/\\/g, '/');
  return process.platform === 'win32' ? root.toLowerCase() : root;
}

/**
 * Файл вердикта попытки. Ключ проекта — хеш канонического корня (регистр на Windows не
 * различается) плюс его имя для человека, разбирающего каталог.
 */
export function verdictPath(paths: WitokPaths, chunk: number, attempt: number): string {
  const root = canonicalRoot(paths.projectRoot);
  const key = `${basename(root) || 'root'}-${createHash('sha256').update(root).digest('hex').slice(0, 16)}`;
  return join(runtimeStateDir(), 'verdicts', key, paths.slug, `chunk-${chunk}-attempt-${attempt}.json`);
}

/** Хеш текущего патча попытки — то, к чему привязан вердикт. `null` — патча нет. */
/** Кэш хэша патча по (путь, mtime, размер): предусловие handoff зовётся на каждый GET витка. */
const patchShaCache = new Map<string, { mtimeMs: number; size: number; sha: string }>();

export function patchShaOf(paths: WitokPaths, chunk: number, attempt: number): string | null {
  const file = paths.chunkDiff(chunk, attempt);
  let st: { mtimeMs: number; size: number; isFile(): boolean };
  try {
    st = statSync(file);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  const hit = patchShaCache.get(file);
  if (hit !== undefined && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.sha;
  const sha = createHash('sha256').update(readFileSync(file, 'utf8')).digest('hex');
  patchShaCache.delete(file);
  patchShaCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, sha });
  // Предел: патчи удалённых рабочих копий и старых попыток больше никто не спросит.
  while (patchShaCache.size > 2000) {
    const oldest = patchShaCache.keys().next().value;
    if (oldest === undefined) break;
    patchShaCache.delete(oldest);
  }
  return sha;
}

function writeStored(paths: WitokPaths, chunk: number, attempt: number, v: StoredVerdict): void {
  const file = verdictPath(paths, chunk, attempt);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ chunk, attempt, ...v }, null, 2)}\n`, 'utf8');
}

export function writeRunVerdict(paths: WitokPaths, chunk: number, attempt: number, verdict: Verdict): void {
  writeStored(paths, chunk, attempt, {
    passed: verdict.passed,
    action: verdict.action,
    reasons: verdict.reasons,
    patchSha: patchShaOf(paths, chunk, attempt),
    committedSha: null,
  });
}

/**
 * Отмечает, что по зелёной попытке сделан локальный коммит: повторный вход в handoff
 * после коммита видит чистое дерево при непустом патче, и без этой отметки принимал это за
 * «дерево ушло от проверенного патча» (code-review-all 2026-09-23).
 */
export function markCommitted(paths: WitokPaths, chunk: number, attempt: number, sha: string): void {
  const v = readRunVerdict(paths, chunk, attempt);
  if (v !== null) writeStored(paths, chunk, attempt, { ...v, committedSha: sha });
}

/**
 * Вердикт попытки или `null`: файла нет или он не разбирается. Отсутствие — обычное
 * состояние (весь этап 5), поэтому проверяется до чтения, а не исключением: предусловия
 * опрашиваются на каждый GET витка.
 */
export function readRunVerdict(paths: WitokPaths, chunk: number, attempt: number): StoredVerdict | null {
  const file = verdictPath(paths, chunk, attempt);
  if (!existsSync(file)) return null;
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (v['chunk'] !== chunk || v['attempt'] !== attempt || typeof v['passed'] !== 'boolean') return null;
  const action = ACTIONS.find((a) => a === v['action']);
  if (action === undefined) return null;
  const reasons = Array.isArray(v['reasons']) ? v['reasons'].filter((r): r is string => typeof r === 'string') : [];
  const str = (x: unknown): string | null => (typeof x === 'string' ? x : null);
  return { passed: v['passed'], action, reasons, patchSha: str(v['patchSha']), committedSha: str(v['committedSha']) };
}

/**
 * Почему зелёный вердикт больше не описывает попытку — `null`, если описывает. Синхронная
 * часть проверки (патч переписан после вердикта); сверку патча с деревом делает handoff
 * перед коммитом. После коммита патч от HEAD не сверяется: попытка уже зафиксирована.
 */
export function stalePatchReason(paths: WitokPaths, chunk: number, attempt: number, v: StoredVerdict): string | null {
  if (v.committedSha !== null) return null;
  return v.patchSha === patchShaOf(paths, chunk, attempt)
    ? null
    : `патч попытки ${attempt} изменён после вердикта этапа 6 — повтори verify для проверки текущего патча; при красном вердикте перейди к новой попытке`;
}

/**
 * Проверялась ли попытка вердиктом по журналу итераций — для витков, начатых до хранения
 * вердикта в рантайме. Решений «принята» по нему не принимается (журнал пишет и модель),
 * только защита улик: chunk по такой попытке не перезаписывает её патч (живой виток ta-13).
 */
export function attemptJudgedInLog(paths: WitokPaths, chunk: number, attempt: number): boolean {
  const log = readIterationsText(paths);
  if (!log.exists) return false;
  const rows = parseIterations(log.text).filter((r) => r.chunk === chunk && r.attempt === attempt);
  // Последняя строка по попытке — `blocked_env`: номер она не занимает, и тот же K
  // прогоняется заново после починки среды (`SDLC.md` → «blocked_env в этот счёт не входит»).
  const last = rows.at(-1);
  return last !== undefined && last.action !== 'blocked_env';
}
