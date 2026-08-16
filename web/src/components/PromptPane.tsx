import { useEffect, useState } from 'react';

import type { PreparedPrompt } from '../lib/types.ts';

/**
 * Полный промпт с правкой перед отправкой.
 *
 * Пометка о скрытом системном пресете обязательна: у флоу `sdk` Claude Code добавляет свой
 * текст сверх нашего, и «полный промпт», который на самом деле неполон, был бы ровно тем
 * ложным зелёным, ради устранения которого этот сервис и существует.
 */
export function PromptPane({
  prompt,
  blockers,
  busy,
  onRun,
}: {
  prompt: PreparedPrompt | null;
  blockers: string[];
  busy: boolean;
  onRun: (edited: { system: string; user: string }) => void;
}): JSX.Element {
  const [system, setSystem] = useState('');
  const [user, setUser] = useState('');
  const [showTools, setShowTools] = useState(false);

  useEffect(() => {
    setSystem(prompt?.system ?? '');
    setUser(prompt?.user ?? '');
  }, [prompt]);

  if (prompt === null) {
    return (
      <div className="rounded-lg border border-neutral-800 p-6 text-sm text-neutral-500">
        Промпт ещё не собран. Нажмите «Собрать промпт», чтобы увидеть, что уйдёт в модель.
      </div>
    );
  }

  const edited = system !== prompt.system || user !== prompt.user;

  return (
    <div className="space-y-3">
      {prompt.presetNote !== null ? (
        <div className="rounded border border-neutral-700 bg-neutral-900/70 p-3 text-xs text-neutral-400">
          {prompt.presetNote}
        </div>
      ) : null}

      {blockers.length > 0 ? (
        <div className="rounded border border-red-800 bg-red-950/30 p-3 text-sm">
          <div className="mb-1 font-medium text-red-300">Этап не начинается:</div>
          <ul className="list-disc space-y-0.5 pl-5 text-red-200/90">
            {blockers.map((b) => (
              <li key={b} className="whitespace-pre-wrap">
                {b}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div>
        <div className="mb-1 flex items-baseline justify-between">
          <label className="text-xs uppercase tracking-wide text-neutral-500">
            Системный блок — тело этапа из SKILL.md + adapter
          </label>
          <span className="text-xs text-neutral-600">{system.length} симв.</span>
        </div>
        <textarea
          value={system}
          onChange={(e) => setSystem(e.target.value)}
          spellCheck={false}
          className="h-64 w-full rounded border border-neutral-800 bg-neutral-950 p-3 font-mono text-xs leading-5"
        />
      </div>

      <div>
        <div className="mb-1 flex items-baseline justify-between">
          <label className="text-xs uppercase tracking-wide text-neutral-500">
            Пользовательское сообщение — входные артефакты
          </label>
          <span className="text-xs text-neutral-600">{user.length} симв.</span>
        </div>
        <textarea
          value={user}
          onChange={(e) => setUser(e.target.value)}
          spellCheck={false}
          className="h-48 w-full rounded border border-neutral-800 bg-neutral-950 p-3 font-mono text-xs leading-5"
        />
      </div>

      <div>
        <button
          type="button"
          onClick={() => setShowTools((v) => !v)}
          className="text-xs text-neutral-400 hover:text-neutral-200"
        >
          {showTools ? '▾' : '▸'} Инструменты этапа ({prompt.tools.length})
        </button>
        {showTools ? (
          <div className="mt-2 space-y-2">
            {prompt.tools.map((t) => (
              <div key={t.name} className="rounded border border-neutral-800 p-2">
                <div className="font-mono text-xs text-neutral-300">{t.name}</div>
                <div className="text-xs text-neutral-500">{t.description}</div>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={busy || blockers.length > 0}
          onClick={() => onRun({ system, user })}
          className="rounded bg-emerald-700 px-4 py-2 text-sm font-medium hover:bg-emerald-600 disabled:cursor-not-allowed disabled:bg-neutral-800 disabled:text-neutral-500"
        >
          {busy ? 'Этап выполняется…' : 'Запустить этап'}
        </button>
        {edited ? <span className="text-xs text-amber-400">промпт отредактирован</span> : null}
      </div>
    </div>
  );
}
