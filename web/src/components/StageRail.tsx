import type { FlowId, RunDetail, StageId } from '@sdlc-runner/shared';

import { computeStageStates } from '../lib/stageProgress.ts';
import type { StageState } from '../lib/stageProgress.ts';

// Ключ — `FlowId`, а не строка: новый флоу должен ловиться сборкой, а не оставаться
// без бейджа молча.
const FLOW_BADGE: Record<FlowId, string> = {
  sdk: 'bg-violet-900/60 text-violet-200',
  loop: 'bg-teal-900/60 text-teal-200',
};

// Ключ — `StageState`: новое состояние без своего вида кружка должно ловиться сборкой.
const CIRCLE: Record<StageState, string> = {
  done: 'bg-emerald-900/70 text-emerald-300',
  running: 'animate-pulse bg-amber-600 text-black',
  available: 'bg-emerald-800 text-emerald-100 ring-2 ring-emerald-500/50',
  blocked: 'bg-neutral-800 text-neutral-500',
};

const TITLE: Record<StageState, string> = {
  done: 'text-neutral-400',
  running: 'text-neutral-200',
  available: 'text-neutral-200',
  blocked: 'text-neutral-500',
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
  // «Пройден» выводится из блокеров чистой функцией — сервер этого состояния не отдаёт.
  const states = computeStageStates(run.stages, run.stage);

  return (
    <nav className="flex w-64 shrink-0 flex-col gap-1 border-r border-neutral-800 p-3">
      <div className="mb-2 px-1 text-xs uppercase tracking-wide text-neutral-500">Этапы витка</div>

      {run.stages.map((s, idx) => {
        const route = run.routes[s.id];
        const state = states[s.id] ?? 'blocked';
        const active = s.id === selected;

        return (
          <button
            key={s.id}
            type="button"
            onClick={() => onSelect(s.id)}
            // У пройденного этапа строка маршрута спрятана в title: полный рельс из семи
            // блоков «flow + модель + блокеры» и был той простынёй, из-за которой прогресс
            // витка не читался одним взглядом.
            title={state === 'done' ? `${route.flow} · ${route.model}` : undefined}
            className={`rounded border px-2.5 py-2 text-left transition ${
              active
                ? 'border-neutral-600 bg-neutral-800/70'
                : 'border-transparent hover:bg-neutral-900'
            }`}
          >
            <div className="flex items-center gap-2">
              <span
                className={`inline-flex h-5 w-5 items-center justify-center rounded-full text-xs ${CIRCLE[state]}`}
              >
                {state === 'done' ? '✓' : idx + 1}
              </span>
              <span className={TITLE[state]}>{s.title}</span>
              {state === 'available' ? (
                <span className="ml-auto text-[10px] uppercase tracking-wide text-emerald-500">
                  вы здесь
                </span>
              ) : null}
            </div>

            {state !== 'done' ? (
              <div className="mt-1 flex items-center gap-1.5 pl-7">
                <span className={`rounded px-1 py-0.5 text-[10px] ${FLOW_BADGE[route.flow] ?? ''}`}>
                  {route.flow}
                </span>
                <span className="truncate text-[11px] text-neutral-500">{route.model}</span>
              </div>
            ) : null}

            {/* Причины показываются ВСЕ: «первая и (+2)» заставляла оператора чинить их по
                одной, перезапуская сборку промпта после каждой, — а предусловия считаются
                чтением файлов, и вторая причина видна ровно так же дёшево, как первая.
                У done-этапов блокеры не показываются: это предусловия ПЕРЕЗАПУСКА, а не
                текущие проблемы — артефакты этапа уже на месте, раз следующий разблокирован. */}
            {state === 'blocked' ? (
              <ul className="mt-1 space-y-0.5 break-words pl-7 text-[11px] leading-4 text-neutral-500">
                {s.blockers.map((b, i) => (
                  <li key={i}>— {b}</li>
                ))}
              </ul>
            ) : null}

            {/* У handoff'а два входа с разными предусловиями: штатная приёмка и объявленный
                обрыв витка. Если штатный закрыт, а обрыв доступен — это и есть выход, и
                молчать о нём значит прятать единственную открытую дверь. */}
            {state === 'blocked' && s.abortBlockers !== null && s.abortBlockers.length === 0 ? (
              <div className="mt-1 pl-7 text-[11px] leading-4 text-amber-400">
                доступен обрыв витка → handoff
              </div>
            ) : null}
          </button>
        );
      })}
    </nav>
  );
}
