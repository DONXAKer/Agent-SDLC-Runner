import { useEffect, useState } from 'react';

import type { DashboardArtifact, DashboardArtifactResponse, DashboardCardRef } from '@sdlc-runner/shared';

import { api } from '../../lib/api.ts';
import { cardKey } from '../../lib/dashboardSort.ts';
import { isMarkdownName } from '../../lib/markdown.ts';
import { ARTIFACT_TONE, artifactTone, fmtBytes } from '../../lib/dashboardStages.ts';
import { MarkdownOrSource } from '../Markdown.tsx';
import { PatchText } from '../PatchText.tsx';
import { CollapsibleSection } from '../run/CollapsibleSection.tsx';

/** Текст с подсвеченными плейсхолдерами `‹…›` — видно, что именно осталось заполнить. */
export function MarkedText({ text }: { text: string }): JSX.Element {
  const parts = text.split(/(‹[^›\n]*›)/);
  return (
    <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-[11px] leading-4 text-neutral-300">
      {parts.map((p, i) =>
        p.startsWith('‹') && p.endsWith('›') ? (
          <mark key={i} className="rounded bg-amber-950/70 px-0.5 text-amber-300">
            {p}
          </mark>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </pre>
  );
}

/**
 * Содержимое грузится при раскрытии, а не с деталями: артефакты бывают в сотни килобайт,
 * а детали перезапрашиваются по каждому изменению живого витка. Ключ монтирования включает
 * время правки файла — изменившийся файл перечитывается, неизменный — нет.
 */
function ArtifactBody({ cardRef, name }: { cardRef: DashboardCardRef; name: string }): JSX.Element {
  const [state, setState] = useState<
    { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'loaded'; data: DashboardArtifactResponse }
  >({ kind: 'loading' });

  // Зависимость — ключ карточки строкой: объект адреса пересоздаётся каждым опросом, и по
  // ссылке файл перечитывался бы на каждый тик.
  const key = cardKey(cardRef);
  useEffect(() => {
    let alive = true;
    api
      .dashboardArtifact(cardRef, name)
      .then((data) => {
        if (alive) setState({ kind: 'loaded', data });
      })
      .catch((e: Error) => {
        if (alive) setState({ kind: 'error', message: e.message });
      });
    return () => {
      alive = false;
    };
  }, [key, name]);

  if (state.kind === 'loading') return <div className="px-3 py-2 text-xs text-neutral-500">загрузка…</div>;
  if (state.kind === 'error') return <div className="px-3 py-2 text-xs text-red-300">{state.message}</div>;
  const { data } = state;
  return (
    <div>
      {data.truncated ? (
        <div className="border-b border-neutral-800 px-3 py-1 text-[11px] text-amber-400">
          показан{data.tail ? ' конец' : 'о начало'}: файл {fmtBytes(data.sizeBytes)}, больше потолка ответа
        </div>
      ) : null}
      {name.endsWith('.patch') ? (
        <PatchText text={data.text} maxHeight="max-h-[60vh]" />
      ) : isMarkdownName(name) ? (
        <MarkdownOrSource text={data.text} source={<MarkedText text={data.text} />} />
      ) : (
        <MarkedText text={data.text} />
      )}
    </div>
  );
}

export function ArtifactViewer({
  cardRef,
  artifact,
  note,
}: {
  cardRef: DashboardCardRef;
  artifact: DashboardArtifact;
  /** Дополнение к сводке («необязательный вход»). */
  note?: string;
}): JSX.Element {
  const tone = ARTIFACT_TONE[artifactTone(artifact)];
  const summary = (
    <span className="flex flex-wrap items-center gap-2">
      <span className={`rounded border px-1 text-[10px] ${tone.cls}`}>
        {tone.glyph} {tone.label}
      </span>
      {artifact.presence !== 'missing' ? <span className="text-neutral-500">{fmtBytes(artifact.sizeBytes)}</span> : null}
      {artifact.placeholders > 0 ? <span className="text-amber-400">‹…› × {artifact.placeholders}</span> : null}
      {artifact.decision !== null ? (
        <span className="text-neutral-400">
          «{artifact.decision.label}»: {ARTIFACT_TONE[artifact.decision.state].label}
        </span>
      ) : null}
      {note !== undefined ? <span className="text-neutral-500">{note}</span> : null}
    </span>
  );

  if (artifact.presence === 'missing') {
    return (
      <div className="mt-2 flex flex-wrap items-center gap-2 rounded border border-dashed border-neutral-800 px-3 py-2 text-xs">
        <span className="font-mono text-neutral-500">{artifact.name}</span>
        {summary}
      </div>
    );
  }
  return (
    <CollapsibleSection title={artifact.name} summary={summary} compact defaultOpen={false}>
      <ArtifactBody key={`${artifact.name}@${artifact.mtime ?? ''}`} cardRef={cardRef} name={artifact.name} />
    </CollapsibleSection>
  );
}
