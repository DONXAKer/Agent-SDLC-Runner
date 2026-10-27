import { useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';

const modalStack: symbol[] = [];

export function Modal({
  title,
  children,
  onClose,
  className = 'max-w-3xl',
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  className?: string;
}): JSX.Element {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const id = Symbol('modal');
    modalStack.push(id);
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusable = panel.current?.querySelector<HTMLElement>('button:not([disabled]), input, textarea, select, [tabindex="0"]');
    (focusable ?? panel.current)?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || modalStack.at(-1) !== id) return;
      event.preventDefault();
      closeRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      const index = modalStack.lastIndexOf(id);
      if (index >= 0) modalStack.splice(index, 1);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, []);

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && modalStack.at(-1) !== undefined) closeRef.current();
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`flex max-h-[calc(100vh-2rem)] w-full flex-col overflow-hidden rounded-lg border border-neutral-700 bg-neutral-950 shadow-2xl outline-none ${className}`}
      >
        <div className="flex shrink-0 items-center gap-3 border-b border-neutral-800 px-4 py-3">
          <h2 id={titleId} className="min-w-0 truncate text-sm font-medium">{title}</h2>
          <button type="button" onClick={() => closeRef.current()} aria-label="Закрыть" className="ml-auto rounded px-2 py-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100">✕</button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">{children}</div>
      </div>
    </div>
  );
}
