import { useEffect, useMemo, useRef } from 'react';

import type { RunEvent } from '@sdlc-runner/shared';
// Описание вызова берётся из общего пакета: пока у интерфейса была своя копия, она
// отставала от нормализатора, и новый вид вызова показывался как «неизвестный».
import { describeCall } from '@sdlc-runner/shared';
// Числа форматируются тем же модулем, что шапка витка и список: одна и та же длительность
// не должна выглядеть как «92000 мс» здесь и «1 мин 32 с» в таблице гейтов ниже.
import { fmtCost, fmtDuration } from '../lib/format.ts';
import { GATE_TONE } from '../lib/gateTone.ts';
import { groupEvents, type EventItem } from '../lib/eventGroups.ts';
import { verdictTextTone, verdictTone } from '../lib/tones.ts';
import { useToggleSet } from '../lib/useToggleSet.ts';

/**
 * Вызов инструмента одной строкой: запрос, решение и результат вместе.
 *
 * Тройка `tool_request → tool_resolved → tool_result` занимала три строки на каждый
 * вызов и ленту читали прокруткой; клик разворачивает исходные строки. Незавершённое
 * не сворачивается в нейтральное: «ждёт решения» обязано оставаться заметным.
 */
function ToolLine({
  item,
  expanded,
  onToggle,
}: {
  item: Extract<EventItem, { kind: 'tool' }>;
  expanded: boolean;
  onToggle: () => void;
}): JSX.Element {
  const { request, resolved, result, status } = item;

  const suffix =
    status === 'ok' ? (
      <span className="text-neutral-500"> ✓ ({fmtDuration(result!.durationMs)})</span>
    ) : status === 'failed' ? (
      <span className="text-red-400"> ✗ {result!.summary}</span>
    ) : status === 'denied' ? (
      // `denied` в eventGroups.ts достижим только когда resolved.decision.allowed === false
      // — ветки «allowed → пусто» здесь не бывает, показывать нечего кроме причины.
      // Проверка `!allowed` вместо `!` — она же и сужает тип `Decision` до варианта с `reason`.
      <span className="text-red-400">
        {' '}
        ✗ {resolved !== undefined && !resolved.decision.allowed ? resolved.decision.reason : ''}
      </span>
    ) : status === 'running' ? (
      <span className="text-neutral-500"> ⋯</span>
    ) : (
      <span className="text-amber-400"> — ждёт решения</span>
    );

  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        className={`block w-full text-left ${request.policy.ok ? 'text-sky-400' : 'text-red-400'}`}
      >
        → {describeCall(request.call)}
        {!request.policy.ok ? ` — отклонено политикой (${request.policy.policy})` : ''}
        {suffix}
      </button>
      {expanded ? (
        <div className="border-l border-neutral-800 pl-2">
          {resolved !== undefined ? (
            <div className="text-neutral-500">
              {resolved.decision.allowed
                ? `✓ разрешено (${resolved.decision.by})`
                : `✗ ${resolved.decision.reason}`}
            </div>
          ) : null}
          {result !== undefined ? (
            <div className={result.ok ? 'text-neutral-500' : 'text-red-400'}>
              {`${result.ok ? '·' : '✗'} ${result.summary} (${fmtDuration(result.durationMs)})`}
            </div>
          ) : null}
          {resolved === undefined && result === undefined ? (
            <div className="text-neutral-600">решения и результата ещё нет</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function PlainEvent({ e }: { e: RunEvent }): JSX.Element | null {
  switch (e.type) {
    case 'assistant_text':
      return (
        <div className="whitespace-pre-wrap font-sans text-sm text-neutral-200">{e.text}</div>
      );

    case 'thinking':
      return <div className="whitespace-pre-wrap italic text-neutral-500">{e.text}</div>;

    // `tool_request` сюда не попадает: `groupEvents` заворачивает КАЖДЫЙ запрос в
    // группу `kind: 'tool'` (множество `requests` строится из тех же событий) — здесь
    // случай не нужен. Осиротевшими бывают только их `resolved`/`result` — см. ниже.
    case 'tool_resolved':
      return (
        <div className="text-neutral-500">
          {e.decision.allowed ? `  ✓ разрешено (${e.decision.by})` : `  ✗ ${e.decision.reason}`}
        </div>
      );

    case 'tool_result':
      return (
        <div className={e.ok ? 'text-neutral-500' : 'text-red-400'}>
          {`  ${e.ok ? '·' : '✗'} ${e.summary} (${fmtDuration(e.durationMs)})`}
        </div>
      );

    case 'artifact_written':
      return (
        <div className={e.placeholders > 0 ? 'text-amber-400' : 'text-emerald-400'}>
          ▪ {e.path}
          {e.placeholders > 0
            ? ` — осталось незаполненных мест: ${e.placeholders}, артефакт не готов`
            : ' — заполнен'}
        </div>
      );

    case 'stage_started':
      return (
        <div className="mt-3 border-t border-neutral-800 pt-2 text-neutral-400">
          ▶ этап {e.stage} · {e.flow} · {e.provider}:{e.model}
        </div>
      );

    case 'stage_done':
      return <div className={e.ok ? 'text-emerald-400' : 'text-red-400'}>■ {e.note}</div>;

    case 'usage':
      return (
        <div className="text-neutral-600">
          {/* Токены здесь ТОЧНЫЕ, без `fmtTokens`: лента — единственное место, где
              расход разбит по вызовам, и по ней сверяют перерасход с биллингом.
              Округление до `1.0K` делало 1000 и 1049 неразличимыми. */}
          ↑{e.usage.inputTokens} ↓{e.usage.outputTokens}
          {/* Локальный маршрут без стоимости в ленте молчит: строка на каждый вызов
              и так плотная, а «без стоимости» повторённое сто раз — шум. */}
          {e.usage.costUsd === null ? '' : ` · ${fmtCost(e.usage)}`}
        </div>
      );

    case 'gate_result':
      return (
        <div className={GATE_TONE[e.gate.status]}>
          {e.gate.status} {e.gate.name}
          <span className="text-neutral-500">
            {' '}
            · {e.gate.command ?? 'встроенная проверка'} · {fmtDuration(e.gate.durationMs)}
          </span>
          <div className="whitespace-pre-wrap pl-4 text-neutral-500">{e.gate.lastLine}</div>
        </div>
      );

    case 'verdict':
      return (
        <div
          className={`mt-2 rounded border p-2 ${verdictTone(e.verdict.passed)} ${verdictTextTone(e.verdict.passed)}`}
        >
          <div className="font-medium">
            вердикт: passed={String(e.verdict.passed)} · {e.verdict.action}
          </div>
          {e.verdict.reasons.map((r, i) => (
            <div key={i} className="whitespace-pre-wrap pl-3 text-neutral-300">
              — {r}
            </div>
          ))}
        </div>
      );

    // Промпт собран заново — это событие обязано быть видным. На этапе 6 рантайм
    // подклеивает к тексту оператора итоги гейтов, и молчание об этом прямо противоречило
    // обещанию «видно, какой именно промпт ушёл»: событие шло в шину и нигде не рисовалось.
    case 'prompt_prepared':
      return (
        <div className="text-neutral-500">
          ≡ промпт собран ({e.prompt.system.length} + {e.prompt.user.length} симв.
          {e.prompt.editedByOperator ? ', с правкой оператора' : ''})
        </div>
      );

    // Отмена шлёт это событие сразу, а исполнитель может доматывать вызов ещё
    // минуту. Без строки в ленте всё это время не происходило ничего видимого, и
    // оператор не знал, дошла ли команда.
    case 'run_finished':
      return (
        <div className={e.ok ? 'text-emerald-400' : 'text-amber-400'}>
          ◼ прогон завершён: {e.note}
        </div>
      );

    case 'warning':
    case 'error':
      return <div className="whitespace-pre-wrap text-amber-400">⚠ {e.message}</div>;

    default:
      return null;
  }
}

export function EventStream({
  events,
  precomputed,
}: {
  events: RunEvent[];
  /**
   * Уже сгруппированные строки, когда вызывающий посчитал их сам (RunPage считает ради
   * счётчика на кнопке): без этого одна и та же лента группировалась дважды на каждый
   * батч событий, а число на кнопке совпадало с лентой по совпадению реализаций, а не
   * по построению.
   */
  precomputed?: EventItem[];
}): JSX.Element {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [events.length]);

  const items = useMemo(() => precomputed ?? groupEvents(events), [events, precomputed]);
  // Раскрытые группы — по requestId и без localStorage: лента живая, помнить нечего.
  const [expanded, toggle] = useToggleSet();

  return (
    <div className="space-y-1.5 font-mono text-xs leading-5">
      {items.map((item, idx) =>
        item.kind === 'tool' ? (
          <ToolLine
            key={item.request.requestId}
            item={item}
            expanded={expanded.has(item.request.requestId)}
            onToggle={() => toggle(item.request.requestId)}
          />
        ) : (
          <PlainEvent key={idx} e={item.event} />
        ),
      )}
      <div ref={end} />
    </div>
  );
}
