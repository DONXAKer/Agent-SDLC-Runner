import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { readLS, writeLS } from '../../lib/persist.ts';

/**
 * Сворачиваемая секция страницы витка.
 *
 * Открытость — три-стейт: явный клик пользователя (хранится в localStorage по `id`)
 * побеждает; без него открытость выводится из режима (компакт → свёрнуто). Так
 * переключение режима меняет всё, чего оператор не трогал руками, и не трогает то, что
 * он выставил сам. `defaultOpen` позволяет секции не прятать красное даже в компакте.
 *
 * `alert` — это НЕ то же самое, что `defaultOpen`: он не просто меняет исходное значение
 * до первого клика, а перекрывает даже СОХРАНЁННЫЙ выбор «свёрнуто». Без этого оператор,
 * однажды свернувший зелёные гейты или пустую очередь решений, навсегда терял таблицу
 * упавшего гейта или карточку ждущего одобрения за той же самой свёрнутой строкой на
 * следующем витке — комментарий «красное не прячем» был бы неправдой. Разворот при alert
 * не пишется в localStorage: закрыть можно на сессию, но новый alert (переход false→true,
 * например свежий ❌ после перезагрузки) снова раскрывает секцию.
 */
export function CollapsibleSection({
  id,
  title,
  summary,
  compact,
  defaultOpen,
  forceOpen = false,
  alert = false,
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
  /** Секция сейчас показывает что-то, что нельзя молча прятать (красный статус, ожидание). */
  alert?: boolean;
  children: ReactNode;
}): JSX.Element {
  const [choice, setChoice] = useState<'open' | 'closed' | null>(() => {
    const v = readLS(`section.${id}`);
    return v === 'open' || v === 'closed' ? v : null;
  });

  // Закрытие под alert — только на сессию, в памяти компонента, а не в localStorage.
  const [sessionOverride, setSessionOverride] = useState<'open' | 'closed' | null>(null);
  const wasAlert = useRef(alert);
  useEffect(() => {
    if (alert && !wasAlert.current) setSessionOverride(null);
    wasAlert.current = alert;
  }, [alert]);

  const open = forceOpen
    ? true
    : alert
      ? (sessionOverride ?? 'open') === 'open'
      : choice !== null
        ? choice === 'open'
        : (defaultOpen ?? !compact);

  const toggle = (): void => {
    const next = open ? 'closed' : 'open';
    if (alert) {
      setSessionOverride(next);
    } else {
      setChoice(next);
      writeLS(`section.${id}`, next);
    }
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
