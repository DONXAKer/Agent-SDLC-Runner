import type { RunDetail, StageId } from '@sdlc-runner/shared';

const FLOW_BADGE: Record<string, string> = {
  sdk: 'bg-violet-900/60 text-violet-200',
  loop: 'bg-teal-900/60 text-teal-200',
};

export function StageRail({
  run,
  selected,
  onSelect,
}: {
  run: RunDetail;
  selected: StageId;
  onSelect: (s: StageId) => void;
}): JSX.Element {
  return (
    <nav className="flex w-64 shrink-0 flex-col gap-1 border-r border-neutral-800 p-3">
      <div className="mb-2 px-1 text-xs uppercase tracking-wide text-neutral-500">Этапы витка</div>

      {run.stages.map((s, idx) => {
        const route = run.routes[s.id];
        const ready = s.blockers.length === 0;
        const active = s.id === selected;
        const running = run.stage === s.id;

        return (
          <button
            key={s.id}
            type="button"
            onClick={() => onSelect(s.id)}
            className={`rounded border px-2.5 py-2 text-left transition ${
              active
                ? 'border-neutral-600 bg-neutral-800/70'
                : 'border-transparent hover:bg-neutral-900'
            }`}
          >
            <div className="flex items-center gap-2">
              <span
                className={`inline-flex h-5 w-5 items-center justify-center rounded-full text-xs ${
                  running
                    ? 'bg-amber-600 text-black'
                    : ready
                      ? 'bg-emerald-800 text-emerald-100'
                      : 'bg-neutral-800 text-neutral-500'
                }`}
              >
                {idx + 1}
              </span>
              <span className={ready ? 'text-neutral-200' : 'text-neutral-500'}>{s.title}</span>
            </div>

            <div className="mt-1 flex items-center gap-1.5 pl-7">
              <span className={`rounded px-1 py-0.5 text-[10px] ${FLOW_BADGE[route.flow] ?? ''}`}>
                {route.flow}
              </span>
              <span className="truncate text-[11px] text-neutral-500">{route.model}</span>
            </div>

            {!ready ? (
              <div className="mt-1 break-words pl-7 text-[11px] leading-4 text-neutral-500">
                {s.blockers[0]}
                {s.blockers.length > 1 ? ` (+${s.blockers.length - 1})` : ''}
              </div>
            ) : null}
          </button>
        );
      })}
    </nav>
  );
}
