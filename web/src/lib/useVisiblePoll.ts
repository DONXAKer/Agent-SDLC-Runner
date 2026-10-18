import { useEffect } from 'react';

/**
 * Фоновый опрос, пока вкладка видна. На скрытой вкладке тики пропускаются — фоновый опрос
 * ушедшего оператора ни к чему. Один хук на список витков и дашборд: оба опрашивают сервер
 * одинаково, и правило «скрытая вкладка молчит» не должно разойтись между ними.
 */
export function useVisiblePoll(tick: () => void, ms: number): void {
  useEffect(() => {
    const t = setInterval(() => {
      if (!document.hidden) tick();
    }, ms);
    return () => clearInterval(t);
  }, [tick, ms]);
}
