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
 * Ранг модели не используется как порог допуска: назначение этапов остаётся решением
 * оператора, а качество подтверждается диагностикой и результатами работы.
 */
export function ProfileEditor({
  models,
  stages,
  onChange,
}: {
  models: ConfigInfo['models'];
  /** Текущий выбор: этап → модель. Пусто — берётся профиль как есть. */
  stages: Partial<Record<StageId, string>>;
  onChange: (next: Partial<Record<StageId, string>>) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);


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
            Назначайте модели по результатам диагностик и задач, которые им предстоит выполнять.
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
                    {m.id}
                  </option>
                ))}
              </select>
            </label>
          ))}

        </div>
      ) : null}
    </div>
  );
}
