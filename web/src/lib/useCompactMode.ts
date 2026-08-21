import { useCallback, useState } from 'react';

import { readLS, writeLS } from './persist.ts';

/**
 * Режим отображения страницы витка: компактный или подробный.
 *
 * Живёт в localStorage, а не в состоянии витка на сервере: это предпочтение оператора и
 * его браузера, а не факт о прогоне — два открытых окна вправе смотреть по-разному.
 */
export function useCompactMode(): { compact: boolean; toggle: () => void } {
  const [compact, setCompact] = useState(() => readLS('viewMode') === 'compact');
  const toggle = useCallback(() => {
    setCompact((prev) => {
      const next = !prev;
      writeLS('viewMode', next ? 'compact' : 'full');
      return next;
    });
  }, []);
  return { compact, toggle };
}
