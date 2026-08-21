import type { GateRunResult } from '@sdlc-runner/shared';

import { fmtDuration } from '../lib/format.ts';
import { GATE_TONE } from '../lib/gateTone.ts';
import { gateSummary } from '../lib/summaries.ts';
import { PANEL_TONE } from '../lib/tones.ts';
import { CollapsibleSection } from './run/CollapsibleSection.tsx';

/**
 * Сводка по гейтам последнего прогона.
 *
 * Существует потому, что до неё гейты жили только в хронологической ленте: чтобы понять,
 * какие проверки вообще прогонялись и какая упала, оператор листал поток вперемешку с
 * текстом модели и вызовами инструментов. Вердикт считается по этой таблице — значит и
 * человек должен видеть её таблицей.
 */

export function GatePanel({
  results,
  aborted,
  compact,
}: {
  results: GateRunResult[];
  /** Прогон оборван отменой — показанный набор неполон. */
  aborted: boolean;
  compact: boolean;
}): JSX.Element | null {
  if (results.length === 0) return null;

  const counts = gateSummary(results);
  // ⏭ тоже роняет вердикт методологии (не только ❌) — прятать «не запускался» за
  // сохранённым закрытием секции так же неверно, как прятать явный провал.
  const hasProblem = results.some((r) => r.status === '❌' || r.status === '⏭');

  return (
    <CollapsibleSection
      id="gates"
      title="Гейты последнего прогона"
      compact={compact}
      defaultOpen={!compact || hasProblem}
      // alert перекрывает и сохранённый в localStorage выбор «свёрнуто» — иначе оператор,
      // однажды закрывший зелёные гейты, навсегда терял таблицу упавшего гейта следующего
      // прогона за той же свёрнутой строкой.
      alert={hasProblem}
      summary={
        <>
          {counts.map((c) => (
            <span key={c.status} className={`mr-2 ${GATE_TONE[c.status]}`}>
              {c.status} {c.n}
            </span>
          ))}
          <span className="text-neutral-500">всего {results.length}</span>
          {/* Отметка обрыва видна и в свёрнутой строке: без неё свёрнутая сводка с
              зелёными счётчиками читалась бы как полный прогон. */}
          {aborted ? <span className="ml-2 text-amber-300">· оборван</span> : null}
        </>
      }
    >
      {aborted ? (
        <div className={`border-b px-3 py-2 text-xs text-amber-300 ${PANEL_TONE.warn}`}>
          Прогон оборван отменой: набор неполон, оставшиеся гейты не запускались. Считать эту
          сводку зелёной нельзя.
        </div>
      ) : null}

      <div className="divide-y divide-neutral-900">
        {results.map((g, i) => (
          // Ключ с индексом: имена гейтов человекописные, в наборе целевого проекта две
          // строки могут называться одинаково.
          <div key={`${g.name}:${i}`} className="px-3 py-2 text-xs">
            <div className="flex items-baseline gap-2">
              <span className={GATE_TONE[g.status]}>{g.status}</span>
              <span className="min-w-0 flex-1 break-words font-medium text-neutral-200">
                {g.name}
              </span>
              {/* Код возврата показывается только когда он есть: у встроенной проверки
                  своего процесса нет, и «код —» читался бы как «упало молча». */}
              {g.exitCode !== null ? (
                <span className={g.exitCode === 0 ? 'text-neutral-500' : 'text-red-400'}>
                  код {g.exitCode}
                </span>
              ) : null}
              <span className="shrink-0 text-neutral-500">{fmtDuration(g.durationMs)}</span>
            </div>

            <div className="mt-0.5 break-all font-mono text-[11px] text-neutral-500">
              {/* «Без команды» вместо «встроенная проверка»: `command: null` бывает трёх
                  разных природ — встроенная реализация, статус, полученный не скриптом
                  (ревью), и «исполнить нечем». Подпись про проверку утверждала бы, что
                  что-то исполнялось, во всех трёх. Что именно было — говорит строка ниже. */}
              {g.command ?? 'без команды'}
            </div>

            {g.lastLine !== '' ? (
              <div className="mt-1 whitespace-pre-wrap break-words border-l border-neutral-800 pl-2 font-mono text-[11px] text-neutral-400">
                {g.lastLine}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </CollapsibleSection>
  );
}
