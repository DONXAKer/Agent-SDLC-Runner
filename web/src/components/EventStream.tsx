import { useEffect, useRef } from 'react';

import type { RunEvent } from '@sdlc-runner/shared';
// Описание вызова берётся из общего пакета: пока у интерфейса была своя копия, она
// отставала от нормализатора, и новый вид вызова показывался как «неизвестный».
import { describeCall } from '@sdlc-runner/shared';

export function EventStream({ events }: { events: RunEvent[] }): JSX.Element {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [events.length]);

  return (
    <div className="space-y-1.5 font-mono text-xs leading-5">
      {events.map((e, idx) => {
        switch (e.type) {
          case 'assistant_text':
            return (
              <div key={idx} className="whitespace-pre-wrap font-sans text-sm text-neutral-200">
                {e.text}
              </div>
            );

          case 'thinking':
            return (
              <div key={idx} className="whitespace-pre-wrap italic text-neutral-500">
                {e.text}
              </div>
            );

          case 'tool_request':
            return (
              <div key={idx} className={e.policy.ok ? 'text-sky-400' : 'text-red-400'}>
                → {describeCall(e.call)}
                {!e.policy.ok ? ` — отклонено политикой (${e.policy.policy})` : ''}
              </div>
            );

          case 'tool_resolved':
            return (
              <div key={idx} className="text-neutral-500">
                {e.decision.allowed
                  ? `  ✓ разрешено (${e.decision.by})`
                  : `  ✗ ${e.decision.reason}`}
              </div>
            );

          case 'tool_result':
            return (
              <div key={idx} className={e.ok ? 'text-neutral-500' : 'text-red-400'}>
                {`  ${e.ok ? '·' : '✗'} ${e.summary} (${e.durationMs} мс)`}
              </div>
            );

          case 'artifact_written':
            return (
              <div key={idx} className={e.placeholders > 0 ? 'text-amber-400' : 'text-emerald-400'}>
                ▪ {e.path}
                {e.placeholders > 0
                  ? ` — осталось незаполненных мест: ${e.placeholders}, артефакт не готов`
                  : ' — заполнен'}
              </div>
            );

          case 'stage_started':
            return (
              <div key={idx} className="mt-3 border-t border-neutral-800 pt-2 text-neutral-400">
                ▶ этап {e.stage} · {e.flow} · {e.provider}:{e.model}
              </div>
            );

          case 'stage_done':
            return (
              <div key={idx} className={e.ok ? 'text-emerald-400' : 'text-red-400'}>
                ■ {e.note}
              </div>
            );

          case 'usage':
            return (
              <div key={idx} className="text-neutral-600">
                ↑{e.usage.inputTokens} ↓{e.usage.outputTokens}
                {e.usage.costUsd === null ? '' : ` · $${e.usage.costUsd.toFixed(4)}`}
              </div>
            );

          case 'gate_result':
            return (
              <div
                key={idx}
                className={
                  e.gate.status === '✅'
                    ? 'text-emerald-400'
                    : e.gate.status === '❌'
                      ? 'text-red-400'
                      : 'text-amber-400'
                }
              >
                {e.gate.status} {e.gate.name}
                <span className="text-neutral-500">
                  {' '}
                  · {e.gate.command ?? 'встроенная проверка'} · {e.gate.durationMs} мс
                </span>
                <div className="whitespace-pre-wrap pl-4 text-neutral-500">{e.gate.lastLine}</div>
              </div>
            );

          case 'verdict':
            return (
              <div
                key={idx}
                className={`mt-2 rounded border p-2 ${
                  e.verdict.passed
                    ? 'border-emerald-800 bg-emerald-950/30 text-emerald-300'
                    : 'border-red-900 bg-red-950/30 text-red-300'
                }`}
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

          case 'warning':
          case 'error':
            return (
              <div key={idx} className="whitespace-pre-wrap text-amber-400">
                ⚠ {e.message}
              </div>
            );

          default:
            return null;
        }
      })}
      <div ref={end} />
    </div>
  );
}
