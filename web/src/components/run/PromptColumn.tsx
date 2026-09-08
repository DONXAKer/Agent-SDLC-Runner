import { useState } from 'react';

import type { AutoApproveRules, PreparedPrompt, StageId } from '@sdlc-runner/shared';

import { PromptPane } from '../PromptPane.tsx';

/**
 * «Запрос к модели»: сборка промпта, автоодобрение, запуск этапа.
 *
 * Своего заголовка секции здесь нет — им служит шапка обёртки `FocusSection` на вкладке
 * «Сейчас», второй дублировал бы её строкой ниже.
 */
export function PromptColumn({
  stage,
  prompt,
  blockers,
  uiBusy,
  busyReason,
  autoRules,
  onAutoRulesChange,
  requirement,
  onRequirementChange,
  onBuild,
  onRun,
}: {
  stage: StageId;
  prompt: PreparedPrompt | null;
  blockers: string[];
  uiBusy: boolean;
  busyReason: string | null;
  autoRules: AutoApproveRules;
  onAutoRulesChange: (next: AutoApproveRules) => void;
  requirement: string;
  onRequirementChange: (v: string) => void;
  onBuild: () => void;
  onRun: (edited: { system: string; user: string }) => void;
}): JSX.Element {
  // Сколько классов вызовов сейчас проходит мимо очереди решений. Число стоит НА КНОПКЕ:
  // панель свёрнута по умолчанию и сбрасывается при перемонтировании, поэтому включённое
  // автоодобрение выглядело точно так же, как выключенное, — вызовы шли мимо гейта без
  // единого признака на экране (ревью).
  const autoOn = Object.values(autoRules).filter(Boolean).length;
  // Свёрнут по умолчанию — но не тогда, когда правила включены: то, что снимает вопросы
  // оператору, обязано быть видно оператору.
  const [autoOpen, setAutoOpen] = useState(autoOn > 0);

  return (
    <section className="min-w-0">
      <div className="mb-2 flex items-center gap-2">
        <button
          type="button"
          onClick={onBuild}
          className="rounded border border-neutral-700 px-2 py-1 text-xs hover:bg-neutral-800"
        >
          Собрать промпт
        </button>
        {/* Правила вместо одного тумблера: «одобрять всё» включало и `Bash`, и
            запись вне плана — то есть ровно то, ради чего гейт существует. */}
        <button
          type="button"
          onClick={() => setAutoOpen(!autoOpen)}
          title="Одобрять выбранные классы вызовов без вопроса до конца этапа"
          className="ml-auto text-xs text-neutral-500 hover:text-neutral-300"
        >
          {autoOpen ? '− ' : '+ '}безопасный автопилот{autoOn > 0 ? ` · ${autoOn}` : ''}
        </button>
      </div>

      {autoOpen ? (
        <div className="mb-3 rounded border border-neutral-800 p-2">
          <div className="flex flex-wrap items-center gap-3 text-xs text-neutral-400">
            {(
              [
                ['planWrites', 'правки в files_to_touch'],
                ['bash', 'команды оболочки'],
                // Отдельно от «остального»: изменяющих MCP-вызовов на этапе 5 десятки, но
                // включать ради них `rest` значит заодно разрешить запись вне плана.
                ['mcpWrites', 'изменяющие MCP-вызовы'],
                ['rest', 'остальное'],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={autoRules[key]}
                  onChange={(e) => onAutoRulesChange({ ...autoRules, [key]: e.target.checked })}
                />
                {label}
              </label>
            ))}
          </div>
          {/* Обещание совпадает с сервером: правила снимает `clearAutoApprove` в `finally`
              запуска, и «на весь виток» здесь означало бы врать. */}
          <p className="mt-1.5 text-[11px] text-neutral-500">
            Одобренные классы вызовов не доходят до очереди решений — сбрасывается по концу
            этапа.
          </p>
        </div>
      ) : null}

      {stage === 'intent' ? (
        <textarea
          value={requirement}
          onChange={(e) => onRequirementChange(e.target.value)}
          placeholder="Задача от человека — что нужно сделать в этом витке"
          className="mb-3 h-24 w-full rounded border border-neutral-800 bg-neutral-950 p-2 text-sm"
        />
      ) : null}

      <PromptPane
        prompt={prompt}
        blockers={blockers}
        busy={uiBusy}
        {...(busyReason === null ? {} : { busyReason })}
        onRun={onRun}
      />
    </section>
  );
}
