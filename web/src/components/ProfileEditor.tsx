import { useState } from 'react';

import type { ConfigInfo, StageId } from '@sdlc-runner/shared';
import { STAGE_ORDER } from '@sdlc-runner/shared';

/**
 * Правка профиля на один виток.
 *
 * Судьба правки названа прямо и в интерфейсе: она применяется к создаваемому витку и НЕ
 * сохраняется в `config/projects/*.json`. Писать конфиг из интерфейса — отдельное решение
 * с отдельными рисками (файл правят и руками, и параллельно), и делать это молча нельзя.
 *
 * Правило рецензента считается здесь же, во время правки. Это дублирование серверной
 * проверки — осознанное: клиент ничего не разрешает, он только предупреждает раньше.
 * Местом, где виток не стартует, остаётся сервер.
 */
export function ProfileEditor({
  models,
  stages,
  base,
  onChange,
}: {
  models: ConfigInfo['models'];
  /** Текущий выбор: этап → модель. Пусто — берётся профиль как есть. */
  stages: Partial<Record<StageId, string>>;
  /**
   * Модели выбранного профиля — то, что действует на нетронутых этапах.
   *
   * Без них правило рецензента считалось только когда оператор трогал ОБА этапа, то есть
   * молчало в самом частом случае: подняли один `chunk` до уровня базового `verify` —
   * клиент ничего не сказал, а сервер отказал в старте.
   */
  base: Record<StageId, string[]>;
  onChange: (next: Partial<Record<StageId, string>>) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);

  const rankOf = (id: string | undefined): number | null =>
    models.find((m) => m.id === id)?.rank ?? null;

  // Эффективная модель этапа: правка оператора, иначе то, что стоит в профиле.
  // Крайние значения ансамбля, как в `checkReviewerRule` на сервере: сильнейший
  // исполнитель против слабейшего рецензента.
  const effectiveRank = (stage: StageId, pick: (a: number, b: number) => number): number | null => {
    const override = rankOf(stages[stage]);
    if (override !== null) return override;
    const ranks = (base[stage] ?? []).map((id: string) => rankOf(id)).filter((r): r is number => r !== null);
    return ranks.length === 0 ? null : ranks.reduce(pick);
  };

  const chunkRank = effectiveRank('chunk', Math.max);
  const verifyRank = effectiveRank('verify', Math.min);
  // Сравнивать нечего только когда ранг не известен ни из правки, ни из профиля.
  const ruleBroken = chunkRank !== null && verifyRank !== null && verifyRank <= chunkRank;

  return (
    <div className="rounded border border-neutral-800 p-3">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="text-xs uppercase tracking-wide text-neutral-500 hover:text-neutral-300"
      >
        {open ? '− ' : '+ '}правка моделей на этот виток
      </button>

      {open ? (
        <div className="mt-2 space-y-1.5">
          <p className="text-xs text-neutral-500">
            Правка применяется к создаваемому витку и <b>не сохраняется</b> в конфиг проекта.
            Ранг проставлен человеком в <code className="font-mono">config/models.json</code> и
            не измерен — он нужен только для правила «рецензент строго сильнее исполнителя».
          </p>

          {STAGE_ORDER.map((stage) => (
            <label key={stage} className="flex items-center gap-2 text-xs">
              <span className="w-16 shrink-0 font-mono text-neutral-500">{stage}</span>
              <select
                value={stages[stage] ?? ''}
                onChange={(e) => {
                  const next = { ...stages };
                  if (e.target.value === '') delete next[stage];
                  else next[stage] = e.target.value;
                  onChange(next);
                }}
                className="w-full rounded border border-neutral-800 bg-neutral-950 px-2 py-1"
              >
                <option value="">— как в профиле —</option>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.id} (rank {m.rank})
                  </option>
                ))}
              </select>
            </label>
          ))}

          {ruleBroken ? (
            <p className="text-xs text-red-300">
              verify не строго сильнее chunk (rank {verifyRank} против {chunkRank}) — сервер
              такой виток не запустит: ревью слабее исполнителя это декорация.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
