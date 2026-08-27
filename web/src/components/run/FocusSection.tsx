import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

/**
 * Секция вкладки «Сейчас», управляемая фокусом (`computeNowFocus`) с ручным оверрайдом.
 *
 * Отличается от `CollapsibleSection` двумя вещами. Открытость по умолчанию здесь диктует
 * машина фокуса, и смена фокуса СБРАСЫВАЕТ ручной выбор: свернувший промпт оператор после
 * конца этапа снова видит его развёрнутым — иначе фокус переставал работать после первого
 * же клика. И содержимое при сворачивании НЕ размонтируется, а прячется CSS: внутри живут
 * textarea с правками промпта (`PromptPane` держит их в useState), и размонтирование
 * молча теряло бы отредактированный текст.
 */
export function FocusSection({
  title,
  summary,
  focused,
  children,
}: {
  title: string;
  /** Строка-сводка, видимая в свёрнутом виде рядом с заголовком. */
  summary?: ReactNode;
  /** Этот блок сейчас главный по машине фокуса — развёрнут, пока оператор не решил иначе. */
  focused: boolean;
  children: ReactNode;
}): JSX.Element {
  const [override, setOverride] = useState<'open' | 'closed' | null>(null);
  const prevFocused = useRef(focused);
  useEffect(() => {
    if (focused !== prevFocused.current) {
      setOverride(null);
      prevFocused.current = focused;
    }
  }, [focused]);

  const open = override !== null ? override === 'open' : focused;

  return (
    <div className="rounded border border-neutral-800">
      <button
        type="button"
        onClick={() => setOverride(open ? 'closed' : 'open')}
        className="flex w-full flex-wrap items-center gap-2 px-3 py-2 text-left text-xs"
      >
        <span className="text-neutral-500">{open ? '▾' : '▸'}</span>
        <span className="font-medium">{title}</span>
        {!open && summary !== undefined ? (
          <span className="min-w-0 text-neutral-400">{summary}</span>
        ) : null}
      </button>
      <div className={open ? 'border-t border-neutral-800 p-3' : 'hidden'}>{children}</div>
    </div>
  );
}
