import { diffLineTone } from '../lib/tones.ts';

/**
 * Построчная раскраска текста патча — общая для сводного просмотра попытки (`RunDiffView`)
 * и файлов витка на дашборде: один патч не должен краситься на двух экранах по-разному.
 */
export function PatchText({ text, maxHeight = 'max-h-[50vh]' }: { text: string; maxHeight?: string }): JSX.Element {
  return (
    <pre className={`${maxHeight} overflow-auto px-3 py-2 font-mono text-[11px] leading-4`}>
      {text.split('\n').map((line, i) => (
        <div key={i} className={diffLineTone(line)}>
          {line === '' ? ' ' : line}
        </div>
      ))}
    </pre>
  );
}
