import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

/**
 * Сворачиваемая секция вкладки «Ход».
 *
 * Открытость — не персистентная: секция получает исходное состояние из `defaultOpen`
 * (управляется единым переключателем «Развернуть/Свернуть всё» на вкладке), а клик по
 * заголовку переопределяет его только в рамках текущего монтирования секции — раньше выбор
 * писался в localStorage по `id`, и секции расходились посекционно между сессиями, что и
 * было частью жалобы на перегруженный компакт-режим. Смена вкладки размонтирует секцию и
 * снимает клик-переопределение — единый переключатель снова решает всё.
 *
 * `alert` — секция сейчас показывает то, что нельзя молча прятать (упавший гейт, топтание
 * на месте): перекрывает даже клик пользователя «свернуть», пока сигнал не исчез. Разворот
 * при alert живёт только в памяти компонента, а не как явный выбор — новый alert (переход
 * false→true) снова раскрывает секцию.
 */
export function CollapsibleSection({
  title,
  summary,
  compact,
  defaultOpen,
  alert = false,
  children,
}: {
  title: string;
  /** Строка-сводка, видимая в свёрнутом виде рядом с заголовком. */
  summary?: ReactNode;
  compact: boolean;
  /** Открытость по умолчанию, когда пользователь ещё не кликал; без неё — `!compact`. */
  defaultOpen?: boolean;
  /** Секция сейчас показывает что-то, что нельзя молча прятать (красный статус, ожидание). */
  alert?: boolean;
  children: ReactNode;
}): JSX.Element {
  const [choice, setChoice] = useState<'open' | 'closed' | null>(null);

  // Клик пользователя переопределяет `compact` только пока действует ТОТ режим, в котором
  // кликнули: смена мастер-тумблера обязана снова решать всё сама, иначе выбор «свернуть»,
  // сделанный в подробном режиме, продолжал бы прятать секцию и после переключения в
  // компактный. Раньше это давали снаружи через `key={compact ? …}` — принудительный
  // remount секции при каждом переключателе, скопированный в три места; сброс здесь один
  // на все точки использования.
  // `useLayoutEffect`, не `useEffect`: последний коммитит и красит кадр СО СТАРЫМ `choice`
  // до того, как эффект успевает сбросить его — на смене мастер-тумблера секция на один
  // кадр показывала прежнее (ручное) состояние и дёргалась при перерисовке. Layout-эффект
  // выполняется синхронно после DOM-мутаций, но до отрисовки браузером — кадра с неверным
  // состоянием не возникает, ровно как при старом `key`-remount.
  const prevCompact = useRef(compact);
  useLayoutEffect(() => {
    if (compact !== prevCompact.current) {
      setChoice(null);
      prevCompact.current = compact;
    }
  }, [compact]);

  // Закрытие под alert — тоже только на время жизни компонента.
  const [sessionOverride, setSessionOverride] = useState<'open' | 'closed' | null>(null);
  const wasAlert = useRef(alert);
  useEffect(() => {
    if (alert && !wasAlert.current) setSessionOverride(null);
    wasAlert.current = alert;
  }, [alert]);

  const open = alert
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
    }
  };

  return (
    <div className="mt-3 rounded border border-neutral-800">
      <button
        type="button"
        onClick={toggle}
        className="flex w-full flex-wrap items-center gap-2 px-3 py-2 text-left text-xs"
      >
        <span className="text-neutral-500">{open ? '▾' : '▸'}</span>
        <span className="font-medium">{title}</span>
        {summary !== undefined ? <span className="min-w-0 text-neutral-400">{summary}</span> : null}
      </button>
      {open ? <div className="border-t border-neutral-800">{children}</div> : null}
    </div>
  );
}
