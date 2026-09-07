import { relativizePaths } from '../../lib/paths.ts';

/** Список артефактов, которые производит выбранный этап. */
export function StageArtifacts({
  produces,
  projectRoot,
}: {
  produces: string[];
  /** Корень проекта — абсолютные пути артефактов показываются относительно него. */
  projectRoot: string;
}): JSX.Element | null {
  if (produces.length === 0) return null;
  return (
    <div className="mt-3">
      <h3 className="mb-1 text-xs uppercase tracking-wide text-neutral-500">Артефакты этапа</h3>
      <ul className="space-y-0.5 font-mono text-xs text-neutral-400">
        {produces.map((p) => (
          // Полный путь остаётся в `title`: усечение без него теряло бы самое важное —
          // каталог, в который этап на самом деле пишет.
          <li key={p} className="truncate" title={p}>
            {relativizePaths(projectRoot, p)}
          </li>
        ))}
      </ul>
    </div>
  );
}
