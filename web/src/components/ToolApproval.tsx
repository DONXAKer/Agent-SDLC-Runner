import { useState } from 'react';

import type { Decision, DiffPreview, NormalizedCall, PolicyVerdict } from '@sdlc-runner/shared';
import { DiffView } from './DiffView.tsx';

export interface PendingCall {
  requestId: string;
  /**
   * Аргументы инструмента в его собственной форме — то, что правит оператор.
   *
   * Не `call`: исполнителю уходит `updatedInput` дословно, в форме инструмента
   * (`file_path`, `old_string`), а нормализованная форма (`path`, `oldStr`) на входе
   * инструмента не значит ничего — правка молча теряла содержимое.
   */
  rawInput: Record<string, unknown>;
  call: NormalizedCall;
  policy: PolicyVerdict;
  preview: DiffPreview | null;
}

function title(call: NormalizedCall): string {
  switch (call.kind) {
    case 'write':
      return `Записать ${call.path}`;
    case 'edit':
      return `Изменить ${call.path}`;
    case 'bash':
      return 'Выполнить команду';
    case 'finalize_artifact':
      return `Финализировать ${call.artifact}`;
    case 'unknown':
      return `Неизвестный инструмент ${call.toolName}`;
    default:
      return call.kind;
  }
}

const POLICY_LABEL: Record<string, string> = {
  pathScope: 'за пределами проекта',
  denyList: 'запрещённая категория',
  planScope: 'вне files_to_touch плана',
  stageTools: 'инструмент не разрешён на этапе',
};

export function ToolApproval({
  pending,
  onResolve,
}: {
  pending: PendingCall;
  onResolve: (requestId: string, decision: Decision) => void;
}): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => JSON.stringify(pending.rawInput, null, 2));
  const blocked = !pending.policy.ok;

  return (
    <div className="rounded-lg border border-amber-700/60 bg-amber-950/20 p-4">
      <div className="mb-2 flex items-baseline justify-between gap-4">
        <h3 className="font-medium text-amber-200">{title(pending.call)}</h3>
        <span className="font-mono text-xs text-neutral-500">{pending.requestId.slice(0, 12)}</span>
      </div>

      {blocked && !pending.policy.ok ? (
        <div className="mb-3 rounded border border-red-800 bg-red-950/40 p-3 text-sm">
          <div className="mb-1 font-medium text-red-300">
            Отклонено политикой — {POLICY_LABEL[pending.policy.policy] ?? pending.policy.policy}
          </div>
          <div className="whitespace-pre-wrap text-red-200/80">{pending.policy.reason}</div>
          <div className="mt-2 text-xs text-neutral-400">
            Это конструкция, а не рекомендация: снять её оператор не может. Агент получил
            ошибку и может на неё отреагировать.
          </div>
        </div>
      ) : null}

      {pending.call.kind === 'bash' ? (
        <pre className="mb-3 overflow-auto rounded border border-neutral-800 bg-neutral-950 p-3 font-mono text-xs text-neutral-300">
          {pending.call.command}
        </pre>
      ) : null}

      {pending.preview !== null ? (
        <div className="mb-3">
          <div className="mb-1 font-mono text-xs text-neutral-400">{pending.preview.path}</div>
          <DiffView before={pending.preview.before} after={pending.preview.after} />
        </div>
      ) : null}

      {editing ? (
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck={false}
          className="mb-3 h-40 w-full rounded border border-neutral-700 bg-neutral-950 p-2 font-mono text-xs"
        />
      ) : null}

      {!blocked ? (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => onResolve(pending.requestId, { allowed: true, updatedInput: null, by: 'operator' })}
            className="rounded bg-emerald-700 px-3 py-1.5 text-sm font-medium hover:bg-emerald-600"
          >
            Одобрить
          </button>
          <button
            type="button"
            onClick={() =>
              onResolve(pending.requestId, {
                allowed: false,
                reason: 'оператор отклонил вызов',
                by: 'operator',
              })
            }
            className="rounded bg-red-800 px-3 py-1.5 text-sm font-medium hover:bg-red-700"
          >
            Отклонить
          </button>
          <button
            type="button"
            onClick={() => setEditing((v) => !v)}
            className="rounded border border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-800"
          >
            {editing ? 'Скрыть аргументы' : 'Править аргументы'}
          </button>
          {editing ? (
            <button
              type="button"
              onClick={() => {
                try {
                  onResolve(pending.requestId, {
                    allowed: true,
                    updatedInput: JSON.parse(draft) as unknown,
                    by: 'operator',
                  });
                } catch {
                  alert('Аргументы не разбираются как JSON');
                }
              }}
              className="rounded bg-amber-700 px-3 py-1.5 text-sm font-medium hover:bg-amber-600"
            >
              Одобрить с правкой
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
