import type { RedCauseKind, RunDetail } from '@sdlc-runner/shared';

import { fmtCost, fmtDuration } from '../../lib/format.ts';
import { redCountTone } from '../../lib/tones.ts';

const RED_CAUSE_LABEL: Record<RedCauseKind, string> = {
  scope: 'запись вне files_to_touch',
  reviewer: 'рецензент разошёлся с прогоном',
  gate: 'упал или не запускался гейт',
  claim: 'пункт приёмки опровергнут',
  integrity: 'инварианты/регрессии/долг',
};

/**
 * Вкладка «Метрики»: числа витка из `detail.metrics` — расход и время по этапам, разбивка
 * красных вердиктов по причинам, попытки по каждому chunk'у. Источник тот же, что видит
 * рантайм при решении об эскалации модели — здесь не пересчитывается ничего заново.
 */
export function RunMetricsPanel({ detail }: { detail: RunDetail }): JSX.Element {
  const { metrics } = detail;
  const stageTitle = new Map(detail.stages.map((s) => [s.id, s.title]));

  return (
    <div className="space-y-6">
      <section>
        <h3 className="mb-2 text-xs uppercase tracking-wide text-neutral-500">Расход по этапам</h3>
        {metrics.stages.length === 0 ? (
          <div className="text-xs text-neutral-500">Ни один этап ещё не запускался.</div>
        ) : (
          <table className="w-full text-xs">
            <thead className="text-neutral-500">
              <tr className="text-left">
                <th className="pb-1 font-normal">Этап</th>
                <th className="pb-1 font-normal">Запусков</th>
                <th className="pb-1 font-normal">Стоимость</th>
                <th className="pb-1 font-normal">Время</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-900">
              {metrics.stages.map((s) => (
                <tr key={s.stage}>
                  <td className="py-1 pr-3 text-neutral-200">{stageTitle.get(s.stage) ?? s.stage}</td>
                  <td className="py-1 pr-3 text-neutral-400">{s.runs}</td>
                  <td className="py-1 pr-3 text-neutral-400">{fmtCost(s.usage)}</td>
                  <td className="py-1 text-neutral-400">{fmtDuration(s.durationMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h3 className="mb-2 text-xs uppercase tracking-wide text-neutral-500">Вердикты</h3>
        {metrics.verdicts.total === 0 ? (
          <div className="text-xs text-neutral-500">Вердиктов ещё не было.</div>
        ) : (
          <>
            <div className="text-xs text-neutral-300">
              Всего {metrics.verdicts.total}, из них красных{' '}
              <span className={redCountTone(metrics.verdicts.red)}>{metrics.verdicts.red}</span>
            </div>
            {metrics.redByCause.length > 0 ? (
              <ul className="mt-1 space-y-0.5 text-xs text-neutral-400">
                {metrics.redByCause.map((c) => (
                  <li key={c.kind}>
                    {RED_CAUSE_LABEL[c.kind]}: {c.count}
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        )}
      </section>

      <section>
        <h3 className="mb-2 text-xs uppercase tracking-wide text-neutral-500">Попытки по chunk'ам</h3>
        {metrics.attemptsByChunk.length === 0 ? (
          <div className="text-xs text-neutral-500">Попыток ещё не было.</div>
        ) : (
          <ul className="space-y-0.5 text-xs text-neutral-400">
            {metrics.attemptsByChunk.map((a) => (
              <li key={a.chunk}>
                chunk {a.chunk}: {a.attempts} из {detail.attemptBudget}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
