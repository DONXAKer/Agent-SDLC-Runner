import type { Escalation, RedCause, Verdict } from '@sdlc-runner/shared';

import { verdictTextTone, verdictTone } from '../../lib/tones.ts';

/**
 * Подпись предложенного хода. Классификация — это «куда возвращать», а не «что стало»:
 * `passed` она не меняет ни в одной ветке.
 */
const SUGGEST_LABEL: Record<RedCause['suggest'], string> = {
  'fix-in-chunk': 'чинить на этапе chunk — контекст у исполнителя есть',
  'back-to-plan': 'назад на plan — правка вышла за границы files_to_touch',
  'escalate-model': 'поднять модель — рецензент разошёлся с фактическим прогоном',
};

/** Карточка вердикта этапа 6: итог, причины, подсказки по эскалации и возврату. */
export function VerdictCard({
  verdict,
  escalation,
  redCause,
}: {
  verdict: Verdict;
  escalation: Escalation;
  redCause: RedCause | null;
}): JSX.Element {
  return (
    <div className={`mt-3 rounded border p-3 text-sm ${verdictTone(verdict.passed)}`}>
      <div className={`mb-1 font-medium ${verdictTextTone(verdict.passed)}`}>
        Вердикт: {verdict.passed ? 'passed' : 'не пройден'} · {verdict.action}
      </div>
      <ul className="space-y-0.5 text-xs text-neutral-300">
        {verdict.reasons.map((r, i) => (
          <li key={i} className="whitespace-pre-wrap break-words">
            — {r}
          </li>
        ))}
      </ul>

      {/* Предложенный ход — подсказка оператору, а не переход: возврат на план
          ломает предусловия следующих этапов, и решает это человек. */}
      {/* Предложение поднять модель — тоже подсказка, а не переход: смена
          модели посреди витка меняет стоимость и поведение. */}
      {escalation.kind !== 'none' ? (
        <div className="mt-2 border-t border-red-900/60 pt-2 text-xs">
          <span className="text-neutral-400">Модель: </span>
          <span
            className={
              escalation.kind === 'suggest' ? 'font-medium text-amber-300' : 'text-neutral-400'
            }
          >
            {escalation.kind === 'suggest'
              ? `поднять chunk до ${escalation.toModelId}`
              : 'поднять нельзя'}
          </span>
          <div className="mt-0.5 whitespace-pre-wrap text-neutral-500">{escalation.why}</div>
        </div>
      ) : null}

      {redCause !== null ? (
        <div className="mt-2 border-t border-red-900/60 pt-2 text-xs">
          <span className="text-neutral-400">Куда возвращать: </span>
          <span className="font-medium text-amber-300">{SUGGEST_LABEL[redCause.suggest]}</span>
          <span className="text-neutral-500"> — решение за вами</span>
        </div>
      ) : null}
    </div>
  );
}
