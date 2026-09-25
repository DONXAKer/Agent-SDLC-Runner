import type { DashboardSource } from '@sdlc-runner/shared';

import { SOURCE_HINT, SOURCE_LABEL, SOURCE_TONE } from '../../lib/dashboardStatus.ts';

export function SourceBadge({ source }: { source: DashboardSource }): JSX.Element {
  return (
    <span title={SOURCE_HINT[source]} className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${SOURCE_TONE[source]}`}>
      {SOURCE_LABEL[source]}
    </span>
  );
}
