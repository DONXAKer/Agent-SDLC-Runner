/**
 * Представление индекса для промпта — без текстов файлов. Считается один раз на этап
 * (`Run.exploreIndexFor`) и уходит и в блок промпта (оба флоу), и в карточки конвейера
 * `exploreFill`: список для показа оператору и список для модели обязаны совпадать — тот
 * же принцип, что у отбора MCP-инструментов.
 */

import type { AxisName } from '../artifacts/planAxes.ts';
import { axisMechanismCandidates } from './axes.ts';
import type { Keywords } from './keywords.ts';
import { rankFiles, reuseCandidates, type RankedFile, type ReuseCandidate } from './rank.ts';
import type { ExploreIndex, FileKind } from './types.ts';

export interface EcosystemLine {
  dir: string;
  label: string;
  build: string | null;
  test: string | null;
}

export interface ExploreIndexView {
  stack: EcosystemLine[];
  tree: { path: string; lines: number; kind: FileKind }[];
  /** Сколько файлов в индексе всего — дерево в блоке может быть обрезано. */
  treeTotal: number;
  skipped: { files: number; bytes: number };
  /** Первые строки README — соглашения проекта словами его авторов. */
  readmeHead: string | null;
  candidates: { path: string; lines: number; kind: FileKind; symbols: string[]; why: string[] }[];
  reuse: { path: string; symbol: string; signature: string; callers: number; why: string[] }[];
  /** `null` — гейт «Разбор последствий» выключен: секцию «Опоры осей» заполнять не надо. */
  axes: Record<AxisName, { path: string; symbol: string | null; line: number }[]> | null;
}

export const README_HEAD_LINES = 30;

export interface BuiltView {
  view: ExploreIndexView;
  ranked: RankedFile[];
  reuse: ReuseCandidate[];
}

export function buildView(index: ExploreIndex, ecosystem: readonly EcosystemLine[], kw: Keywords, axesEnabled: boolean): BuiltView {
  const ranked = rankFiles(index, kw);
  const reuse = reuseCandidates(index, ranked, kw);
  const readme = index.files.find((f) => f.kind === 'doc');
  const axes = axesEnabled
    ? (Object.fromEntries(
        Object.entries(axisMechanismCandidates(index)).map(([axis, hits]) => [
          axis,
          hits.map((h) => ({ path: h.path, symbol: h.symbol, line: h.line })),
        ]),
      ) as ExploreIndexView['axes'])
    : null;
  return {
    ranked,
    reuse,
    view: {
      stack: [...ecosystem],
      tree: index.files.map((f) => ({ path: f.path, lines: f.lines, kind: f.kind })),
      treeTotal: index.files.length,
      skipped: index.skipped,
      readmeHead: readme === undefined ? null : readme.text.split(/\r?\n/).slice(0, README_HEAD_LINES).join('\n'),
      candidates: ranked.map((r) => ({
        path: r.file.path,
        lines: r.file.lines,
        kind: r.file.kind,
        symbols: r.file.symbols.map((s) => (s.exported ? s.name : `${s.name} (не экспортируется)`)),
        why: r.why,
      })),
      reuse: reuse.map((c) => ({ ...c })),
      axes,
    },
  };
}
