import { useState } from 'react';

/**
 * Множество раскрытых id с переключателем — без localStorage: используется там, где
 * набор живёт одну сессию (лента событий, список файлов патча), и раньше эта же пара
 * `useState<Set> + toggle` была продублирована в каждом таком месте отдельно.
 */
export function useToggleSet(): [ReadonlySet<string>, (id: string) => void] {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string): void => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  return [open, toggle];
}
