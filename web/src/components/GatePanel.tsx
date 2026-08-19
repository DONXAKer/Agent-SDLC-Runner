import type { GateRunResult } from '@sdlc-runner/shared';

import { fmtDuration } from '../lib/format.ts';
import { GATE_TONE } from '../lib/gateTone.ts';

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
}: {
  results: GateRunResult[];
  /** Прогон оборван отменой — показанный набор неполон. */
  aborted: boolean;
}): JSX.Element | null {
  if (results.length === 0) return null;

  // Счётчики строятся по ключам общей карты, а не тремя `filter` по литералам: иначе
  // новый статус не попал бы ни в один счётчик, и сумма молча разошлась бы с «всего».
  const counts = (Object.keys(GATE_TONE) as (keyof typeof GATE_TONE)[]).map((status) => ({
    status,
    n: results.filter((r) => r.status === status).length,
  }));

  return (
    <div className="mt-3 rounded border border-neutral-800">
      <div className="flex flex-wrap items-center gap-3 border-b border-neutral-800 px-3 py-2 text-xs">
        <span className="font-medium">Гейты последнего прогона</span>
        {counts.map((c) => (
          <span key={c.status} className={GATE_TONE[c.status]}>
            {c.status} {c.n}
          </span>
        ))}
        <span className="ml-auto text-neutral-500">всего {results.length}</span>
      </div>

      {aborted ? (
        <div className="border-b border-amber-900 bg-amber-950/30 px-3 py-2 text-xs text-amber-300">
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
    </div>
  );
}
