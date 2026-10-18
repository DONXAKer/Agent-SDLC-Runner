/**
 * Запись собственного артефакта этапа не по его пути — ошибка АДРЕСАЦИИ, а не границы.
 *
 * Живой класс (серии test27–test29, 2026-09-22…23): на этапе `ask` модель пишет
 * `clarification-report.md` по голому имени (в корень проекта) или в `.sdlc/<слаг с
 * опечаткой>/…` — `planScope` отклоняет запись как «вне плана», стенд ставит метку
 * «опасна», а этап остаётся без артефакта. Ни одна из этих записей не пыталась выйти за
 * проект: имя файла совпало с артефактом, который этап ОБЯЗАН произвести, разошёлся только
 * путь. Адрес — то, что рантайм знает точно (`PolicyContext.stageArtifacts`, та же карта,
 * что резолвит `FillField` по ключу), и гадать о нём модели незачем: путь подставляется
 * до политики, тем же приёмом, что `repairErasedDecisions` возвращает стёртое поле.
 *
 * Чего здесь НЕТ: решения о доступе. Перенаправленный вызов идёт в политику как любой
 * другой — `planScope`/`pathScope`/`denyList` судят уже канонический путь; защищённый
 * артефакт (план после одобрения, задача на этапе 3) отклоняется как прежде.
 *
 * Перенаправляются ровно два описанных вида адреса: голое имя в корне проекта и путь под
 * `.sdlc/` (слаг с опечаткой). Путь вне проекта — не адресация, а выход за границу: его
 * судит `pathScope`, и отказ остаётся видимым. Файл с тем же именем в другом каталоге
 * проекта (`docs/plan.md`) — продуктовый файл, а не заблудившийся артефакт: на этапах 1–4
 * `planFiles` нет, и без этого правила такая запись молча перезаписывала бы артефакт витка
 * (code-review-all 2026-09-23).
 */

import { basename } from 'node:path';

import type { ArtifactKey, NormalizedCall, PolicyContext } from '@sdlc-runner/shared';

import { PATH_ARG_KEYS } from '../exec/normalize.ts';
import {
  isWindowsStyle,
  lexicalNormalize,
  normalizePlanPath,
  pathsEqual,
  relativizeWithin,
  resolveUserPath,
} from '../policy/paths.ts';

export interface ArtifactReaddress {
  /** Путь, как его назвал вызов. */
  from: string;
  /** Канонический путь артефакта этапа. */
  to: string;
  key: ArtifactKey;
}

export function readdressOwnArtifact(call: NormalizedCall, ctx: PolicyContext): ArtifactReaddress | null {
  if (call.kind !== 'write' && call.kind !== 'edit') return null;
  if (ctx.noArtifactReaddress === true) return null;
  const artifacts = ctx.stageArtifacts ?? [];
  if (artifacts.length === 0) return null;
  const ci = isWindowsStyle(ctx.projectRoot);
  // Some models join the artifact directory and filename with `(` instead of
  // `/`, e.g. `.sdlc/run-slug(intent.md`. Repair only this exact typo for a
  // known stage artifact under the run's .sdlc directory. The canonical path
  // still goes through the normal policy checks below.
  const malformed = artifacts.find((artifact) => {
    const canonical = lexicalNormalize(artifact.path);
    const canonicalRel = relativizeWithin(ctx.projectRoot, canonical);
    if (canonicalRel === null || !pathsEqual(canonicalRel.split('/')[0] ?? '', '.sdlc', ci)) return false;
    const slash = canonicalRel.lastIndexOf('/');
    if (slash < 0) return false;
    const file = canonicalRel.slice(slash + 1);
    const expectedTypos = [
      `${canonicalRel.slice(0, slash)}(${file}`,
      `${canonicalRel.slice(0, slash)}(${file})`,
    ];
    const requestedRel = relativizeWithin(ctx.projectRoot, resolveUserPath(ctx.projectRoot, call.path));
    return requestedRel !== null && expectedTypos.some((typo) => pathsEqual(requestedRel, typo, ci));
  });
  if (malformed !== undefined) {
    const canonical = lexicalNormalize(malformed.path);
    const rel = relativizeWithin(ctx.projectRoot, canonical);
    if (rel === null || (ctx.planFiles ?? []).some((p) => pathsEqual(rel, normalizePlanPath(ctx.projectRoot, p), ci))) {
      return null;
    }
    return { from: call.path, to: canonical, key: malformed.key };
  }
  const name = basename(lexicalNormalize(call.path));
  if (name === '') return null;
  const entry = artifacts.find((a) => pathsEqual(basename(lexicalNormalize(a.path)), name, ci));
  if (entry === undefined) return null;
  const canonical = lexicalNormalize(entry.path);
  const abs = resolveUserPath(ctx.projectRoot, call.path);
  if (pathsEqual(abs, canonical, ci)) return null;
  const rel = relativizeWithin(ctx.projectRoot, abs);
  if (rel === null) return null;
  const inRoot = !rel.includes('/');
  const underSdlc = pathsEqual(rel.split('/')[0] ?? '', '.sdlc', ci);
  if (!inRoot && !underSdlc) return null;
  if ((ctx.planFiles ?? []).some((p) => pathsEqual(rel, normalizePlanPath(ctx.projectRoot, p), ci))) {
    return null;
  }
  return { from: call.path, to: canonical, key: entry.key };
}

/** Сырые аргументы с подставленным путём — под тем ключом, под которым путь пришёл (`normalize.ts`). */
export function withReaddressedPath(rawInput: Record<string, unknown>, to: string): Record<string, unknown> {
  const key = PATH_ARG_KEYS.find((k) => typeof rawInput[k] === 'string') ?? 'file_path';
  return { ...rawInput, [key]: to };
}
