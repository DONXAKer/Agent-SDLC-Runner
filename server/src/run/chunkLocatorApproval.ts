import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { extractFilesToTouch } from '../artifacts/planFiles.ts';
import { planSteps } from '../artifacts/planSteps.ts';

export interface LocatorMapFile {
  path: string;
  state: 'existing' | 'new';
  anchor: string | null;
  change: string;
}

export interface LocatorMapResult {
  files: LocatorMapFile[];
}

const normalizePath = (path: string): string => path.replace(/\\/gu, '/').replace(/^\.\//u, '').toLowerCase();

/** Build a mechanically grounded map from the already approved plan and live filesystem. */
export function buildRuntimeLocatorMap(
  planText: string,
  projectRoot: string,
): LocatorMapResult | null {
  const steps = planSteps(planText);
  const stepByPath = new Map(steps.map((step) => [normalizePath(step.file), step]));
  const files: LocatorMapFile[] = [];
  for (const path of extractFilesToTouch(planText)) {
    if (path === '' || path.startsWith('/') || path.split('/').includes('..')) return null;
    const absolute = resolve(projectRoot, path);
    const back = relative(resolve(projectRoot), absolute);
    if (back.startsWith('..') || isAbsolute(back)) return null;
    if (!existsSync(absolute)) {
      files.push({ path, state: 'new', anchor: null, change: stepByPath.get(normalizePath(path))?.action ?? `создать ${path}` });
      continue;
    }
    let contents: string;
    try { contents = readFileSync(absolute, 'utf8'); } catch { return null; }
    const lines = contents.split(/\r?\n/u);
    const step = stepByPath.get(normalizePath(path));
    const symbol = step?.symbol;
    const anchor = (symbol === null || symbol === undefined ? undefined : lines.find((line) => line.includes(symbol))) ??
      lines.find((line) => /^\s*(?:export\s+)?(?:type|interface|class|function|const|import)\b/u.test(line)) ??
      lines.find((line) => line.trim() !== '');
    if (anchor === undefined) return null;
    files.push({
      path,
      state: 'existing',
      anchor: anchor.trim(),
      change: step?.action ?? `изменить ${path} по одобренному плану`,
    });
  }
  return files.length === 0 ? null : { files };
}

/** Parse and verify the locator's JSON against the approved plan and current tree. */
export function validateLocatorMap(
  response: string,
  plannedFiles: readonly string[],
  projectRoot: string,
): { ok: true; value: LocatorMapResult } | { ok: false; reason: string } {
  const trimmed = response.trim();
  const fencedJson = [...trimmed.matchAll(/```json\s*([\s\S]*?)```/giu)];
  const anyFence = [...trimmed.matchAll(/```/gu)];
  if (anyFence.length > 0 && (fencedJson.length !== 1 || anyFence.length !== 2)) {
    return { ok: false, reason: 'ответ locator содержит неоднозначные блоки кода' };
  }
  const jsonText = fencedJson.length === 1
    ? (fencedJson[0]?.[1] ?? '').trim()
    : trimmed.replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '');
  let payload: unknown;
  try { payload = JSON.parse(jsonText); } catch { return { ok: false, reason: 'ответ locator не является JSON' }; }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { ok: false, reason: 'корень JSON должен быть объектом' };
  const object = payload as Record<string, unknown>;
  if (Object.keys(object).sort().join(',') !== 'files,reason,status' || !Array.isArray(object.files) ||
      (object.status !== 'matched' && object.status !== 'diverged') ||
      (object.reason !== null && typeof object.reason !== 'string')) {
    return { ok: false, reason: 'locator не подтвердил совпадение карты или вернул неверную схему' };
  }
  if (object.status !== 'matched' || object.reason !== null) {
    return { ok: false, reason: typeof object.reason === 'string' && object.reason !== '' ? object.reason : 'locator отметил расхождение' };
  }
  if (plannedFiles.length === 0) return { ok: false, reason: 'в одобренном плане нет files_to_touch' };
  const expected = new Set(plannedFiles.map(normalizePath));
  if (expected.size !== plannedFiles.length) return { ok: false, reason: 'в плане повторяются пути' };
  const seen = new Set<string>();
  const files: LocatorMapFile[] = [];
  for (const raw of object.files) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'карточка пути должна быть объектом' };
    const row = raw as Record<string, unknown>;
    if (Object.keys(row).sort().join(',') !== 'anchor,change,path,state' ||
        typeof row.path !== 'string' || typeof row.change !== 'string' || row.change.trim() === '' ||
        (row.state !== 'existing' && row.state !== 'new') ||
        (row.anchor !== null && typeof row.anchor !== 'string')) {
      return { ok: false, reason: 'карточка пути не соответствует схеме path/state/anchor/change' };
    }
    const path = row.path.replace(/\\/gu, '/');
    const key = normalizePath(path);
    if (key === '' || path.startsWith('/') || path.split('/').includes('..') || !expected.has(key)) {
      return { ok: false, reason: `путь locator не входит в одобренный план: ${row.path}` };
    }
    if (seen.has(key)) return { ok: false, reason: `locator повторил путь ${row.path}` };
    seen.add(key);
    const absolute = resolve(projectRoot, path);
    const back = relative(resolve(projectRoot), absolute);
    if (back.startsWith('..') || isAbsolute(back)) return { ok: false, reason: `путь вышел из проекта: ${row.path}` };
    const exists = existsSync(absolute);
    if (row.state === 'new') {
      if (exists || row.anchor !== null) return { ok: false, reason: `новый путь существует или получил якорь: ${row.path}` };
    } else {
      if (!exists || typeof row.anchor !== 'string' || row.anchor.trim() === '') {
        return { ok: false, reason: `нет проверяемого якоря существующего файла ${row.path}` };
      }
      let contents: string;
      try { contents = readFileSync(absolute, 'utf8'); } catch { return { ok: false, reason: `не удалось прочитать якорь ${row.path}` }; }
      if (!contents.includes(row.anchor)) return { ok: false, reason: `цитата locator не найдена в ${row.path}` };
    }
    files.push({ path, state: row.state, anchor: row.anchor, change: row.change.trim() });
  }
  if (seen.size !== expected.size || [...expected].some((path) => !seen.has(path))) {
    return { ok: false, reason: 'карта locator не покрывает все пути одобренного плана' };
  }
  return { ok: true, value: { files } };
}

/** Reuse the current plan approval only after the locator map passed exact runtime checks. */
export function fillVerifiedChunkLocation(
  journal: string,
  files: readonly LocatorMapFile[],
  approvedOn: string,
  points: readonly string[],
): string | null {
  const pointsPlaceholder = '- Точки правки по итогам точечной разведки: ‹файл:символ, …›';
  const mapPlaceholder = '- Карта разведки: совпала / разошлась — ‹что именно; расхождение = возврат на план›';
  const decisionPlaceholder = '- **Подтвердил:** ‹имя› · ‹дата›';
  if (!journal.includes(pointsPlaceholder) || !journal.includes(mapPlaceholder) || !journal.includes(decisionPlaceholder) || files.length === 0 || points.length !== files.length) return null;
  const mapSummary = files.map((file) => file.state === 'existing'
    ? `${file.path}: якорь найден в файле`
    : `${file.path}: новый файл отсутствует, как и ожидается`).join('; ');
  return journal
    .replace(pointsPlaceholder, `- Точки правки по итогам точечной разведки: ${points.join(', ')}`)
    .replace(mapPlaceholder, `- Карта разведки: совпала — ${mapSummary}`)
    .replace(decisionPlaceholder, `- **Подтвердил:** одобрение плана этой сессии · ${approvedOn}`)
    // The template explains the permitted plan-approval wording with a sample date.
    // Replace that instructional token too, or FinalizeArtifact mistakes it for a
    // missing journal value even though the actual decision line is already filled.
    .replace('‹дата›', approvedOn);
}
