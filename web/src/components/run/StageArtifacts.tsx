/** Список артефактов, которые производит выбранный этап. */
export function StageArtifacts({ produces }: { produces: string[] }): JSX.Element | null {
  if (produces.length === 0) return null;
  return (
    <div className="mt-3">
      <h3 className="mb-1 text-xs uppercase tracking-wide text-neutral-500">Артефакты этапа</h3>
      <ul className="space-y-0.5 font-mono text-xs text-neutral-400">
        {produces.map((p) => (
          <li key={p} className="break-all">
            {p}
          </li>
        ))}
      </ul>
    </div>
  );
}
