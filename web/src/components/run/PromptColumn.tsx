import type { AutoApproveRules, PreparedPrompt, StageId } from '@sdlc-runner/shared';

import { PromptPane } from '../PromptPane.tsx';

/** Левая колонка «Запрос к модели»: сборка промпта, автоодобрение, запуск этапа. */
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
  compact,
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
  compact: boolean;
}): JSX.Element {
  return (
    <section className="min-w-0">
      <div className="mb-2 flex items-center gap-2">
        <h2 className="text-sm font-medium">Запрос к модели</h2>
        <button
          type="button"
          onClick={onBuild}
          className="rounded border border-neutral-700 px-2 py-1 text-xs hover:bg-neutral-800"
        >
          Собрать промпт
        </button>
        {/* Правила вместо одного тумблера: «одобрять всё» включало и `Bash`, и
            запись вне плана — то есть ровно то, ради чего гейт существует. */}
        <span className="ml-auto flex items-center gap-3 text-xs text-neutral-400">
          <span className="text-neutral-500">одобрять без вопроса:</span>
          {(
            [
              ['planWrites', 'правки в files_to_touch'],
              ['bash', 'команды оболочки'],
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
        </span>
      </div>

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
        compact={compact}
      />
    </section>
  );
}
