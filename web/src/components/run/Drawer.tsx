import { useEffect } from 'react';
import type { ReactNode } from 'react';

import { BTN_SECONDARY } from '../../lib/tones.ts';

/**
 * Выезжающая панель для «наблюдательных» поверхностей — ленты, диффа витка, метрик.
 *
 * Они больше не живут отдельной вкладкой: вкладка размонтировала центр с очередью
 * решений, и ждущая карточка исчезала из виду ровно тогда, когда человек ушёл читать
 * ленту. Панель ложится ПОВЕРХ, очередь остаётся смонтированной под ней.
 */
export function Drawer({
  title,
  banner,
  onClose,
  children,
}: {
  title: string;
  /**
   * Сигнал поверх панели — обычно «N решений ждут». Панель закрывает очередь целиком и
   * тем самым съедает её видимость; без этой строки ждущее одобрение при открытой ленте
   * не сигналилось бы ничем, кроме счётчика в заголовке вкладки браузера.
   */
  banner?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // Esc в поле ввода снимает фокус/отменяет ввод, а не закрывает панель с потерей
      // набранного — полей внутри пока нет, но первое же (фильтр ленты) попало бы сюда.
      const t = e.target;
      if (t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative flex h-full w-full max-w-3xl flex-col border-l border-neutral-800 bg-neutral-950">
        <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-2.5">
          <h2 className="text-sm font-medium">{title}</h2>
          <button type="button" onClick={onClose} className={`${BTN_SECONDARY} px-2 py-0.5 text-xs`}>
            закрыть · Esc
          </button>
        </div>
        {banner !== undefined ? banner : null}
        <div className="min-h-0 flex-1 overflow-auto p-4">{children}</div>
      </div>
    </div>
  );
}
