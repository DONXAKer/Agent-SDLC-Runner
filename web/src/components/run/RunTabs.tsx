export type RunTab = 'now' | 'progress' | 'metrics';

const TABS: { id: RunTab; title: string }[] = [
  { id: 'now', title: 'Сейчас' },
  { id: 'progress', title: 'Ход' },
  { id: 'metrics', title: 'Метрики' },
];

/**
 * Переключатель вкладок страницы витка: «Сейчас» (что требует действия) отдельно от «Ход»
 * (наблюдение — лента, гейты, diff, попытки, вердикт) и «Метрики» (числа витка). До вкладок
 * всё это рендерилось одним потоком, и структура «что делать» vs «что происходит»
 * читалась только прокруткой.
 */
export function RunTabs({
  tab,
  onSelect,
  nowCount,
}: {
  tab: RunTab;
  onSelect: (t: RunTab) => void;
  /** Число ждущих решений — на вкладке «Сейчас» рядом с названием. */
  nowCount: number;
}): JSX.Element {
  return (
    <div className="mb-3 flex gap-1 border-b border-neutral-800">
      {TABS.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onSelect(t.id)}
          className={`px-3 py-1.5 text-sm ${
            tab === t.id
              ? 'border-b-2 border-neutral-200 text-neutral-100'
              : 'text-neutral-500 hover:text-neutral-300'
          }`}
        >
          {t.title}
          {t.id === 'now' && nowCount > 0 ? (
            <span className="ml-1.5 rounded bg-amber-900/60 px-1.5 py-0.5 text-xs text-amber-300">
              {nowCount}
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}
