import type { DashboardStage, StageId } from '@sdlc-runner/shared';

import { ARTIFACT_TONE, artifactTone, groupArtifactsByStage } from '../../lib/dashboardStages.ts';
import { tailPath } from '../../lib/paths.ts';

/**
 * Статус файлов витка чипами: есть / с незаполненными местами / нет / решение человека.
 * В компактном виде — первые чипы и счётчик остальных: карточка в сетке не должна
 * превращаться в оглавление каталога.
 */
export function ArtifactChips({
  stages,
  titles = {},
  compact = false,
}: {
  stages: readonly Pick<DashboardStage, 'id' | 'outputs'>[];
  titles?: Partial<Record<StageId, string>>;
  compact?: boolean;
}): JSX.Element | null {
  const groups = groupArtifactsByStage(stages);
  const all = groups.flatMap((g) => g.items.map((a) => ({ stage: g.stage, a })));
  if (all.length === 0) return null;
  const LIMIT = 8;
  const shown = compact ? all.slice(0, LIMIT) : all;
  const rest = all.length - shown.length;
  return (
    <div className="flex flex-wrap gap-1">
      {shown.map(({ stage, a }) => {
        const tone = ARTIFACT_TONE[artifactTone(a)];
        const extra = a.placeholders > 0 ? ` · ‹…› × ${a.placeholders}` : '';
        return (
          <span
            key={`${stage}:${a.name}`}
            title={`${titles[stage] ?? stage}: ${a.name} — ${tone.label}${extra}`}
            className={`rounded border px-1.5 py-px font-mono text-[10px] ${tone.cls}`}
          >
            {tone.glyph} {tailPath(a.name)}
          </span>
        );
      })}
      {rest > 0 ? <span className="px-1 text-[10px] text-neutral-500">+{rest}</span> : null}
    </div>
  );
}
