import { useState } from 'react';
import type { ReactNode } from 'react';

import { readLS, writeLS } from '../../lib/persist.ts';

/**
 * Сворачиваемая секция страницы витка.
 *
 * Открытость — три-стейт: явный клик пользователя (хранится в localStorage по `id`)
 * побеждает; без него открытость выводится из режима (компакт → свёрнуто). Так
 * переключение режима меняет всё, чего оператор не трогал руками, и не трогает то, что
 * он выставил сам. `defaultOpen` позволяет секции не прятать красное даже в компакте.
 */
export function CollapsibleSection({
  id,
  title,
  summary,
  compact,
  defaultOpen,
  forceOpen = false,
  children,
}: {
  /** Ключ в localStorage — общий на все витки: сворачивают тип секции, а не экземпляр. */
  id: string;
  title: string;
  /** Строка-сводка, видимая в свёрнутом виде рядом с заголовком. */
  summary?: ReactNode;
  compact: boolean;
  /** Открытость по умолчанию, когда пользователь ещё не выбирал; без неё — `!compact`. */
  defaultOpen?: boolean;
  /** Секцию нельзя свернуть — например очередь решений в компакте. */
  forceOpen?: boolean;
  children: ReactNode;
}): JSX.Element {
  const [choice, setChoice] = useState<'open' | 'closed' | null>(() => {
    const v = readLS(`section.${id}`);
    return v === 'open' || v === 'closed' ? v : null;
  });

  const open = forceOpen || (choice !== null ? choice === 'open' : (defaultOpen ?? !compact));

  const toggle = (): void => {
    const next = open ? 'closed' : 'open';
    setChoice(next);
    writeLS(`section.${id}`, next);
  };

  return (
    <div className="mt-3 rounded border border-neutral-800">
      <button
        type="button"
        onClick={toggle}
        disabled={forceOpen}
        className="flex w-full flex-wrap items-center gap-2 px-3 py-2 text-left text-xs disabled:cursor-default"
      >
        {!forceOpen ? <span className="text-neutral-500">{open ? '▾' : '▸'}</span> : null}
        <span className="font-medium">{title}</span>
        {summary !== undefined ? <span className="min-w-0 text-neutral-400">{summary}</span> : null}
      </button>
      {open ? <div className="border-t border-neutral-800">{children}</div> : null}
    </div>
  );
}
