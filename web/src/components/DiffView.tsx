import { useMemo } from 'react';

type Row = { kind: ' ' | '+' | '-'; text: string };

/**
 * Построчный diff по наибольшей общей подпоследовательности.
 *
 * Наивное сравнение «строка i против строки i» показывает всё после первой вставки как
 * изменённое, и оператор перестаёт читать такой diff уже на втором просмотре.
 */
function diffLines(before: string, after: string): Row[] {
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');

  // Таблица длин LCS. Файлы здесь — исходники, не гигабайты, так что O(n·m) допустим.
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const rows: Row[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ kind: ' ', text: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      rows.push({ kind: '-', text: a[i]! });
      i++;
    } else {
      rows.push({ kind: '+', text: b[j]! });
      j++;
    }
  }
  while (i < n) rows.push({ kind: '-', text: a[i++]! });
  while (j < m) rows.push({ kind: '+', text: b[j++]! });
  return rows;
}

/** Свернуть длинные неизменённые куски — читать 400 одинаковых строк никто не станет. */
function collapse(rows: Row[], context: number): (Row | { kind: '…'; text: string })[] {
  const keep = new Set<number>();
  rows.forEach((r, idx) => {
    if (r.kind === ' ') return;
    for (let k = idx - context; k <= idx + context; k++) if (k >= 0 && k < rows.length) keep.add(k);
  });

  const out: (Row | { kind: '…'; text: string })[] = [];
  let skipped = 0;
  rows.forEach((r, idx) => {
    if (keep.has(idx)) {
      if (skipped > 0) {
        out.push({ kind: '…', text: `${skipped} строк без изменений` });
        skipped = 0;
      }
      out.push(r);
    } else {
      skipped++;
    }
  });
  if (skipped > 0) out.push({ kind: '…', text: `${skipped} строк без изменений` });
  return out;
}

export function DiffView({ before, after }: { before: string | null; after: string }): JSX.Element {
  const rows = useMemo(() => collapse(diffLines(before ?? '', after), 3), [before, after]);
  const added = rows.filter((r) => r.kind === '+').length;
  const removed = rows.filter((r) => r.kind === '-').length;

  return (
    <div className="rounded border border-neutral-800 bg-neutral-900/60">
      <div className="flex gap-3 border-b border-neutral-800 px-3 py-1.5 text-xs text-neutral-400">
        {before === null ? <span className="text-emerald-400">новый файл</span> : null}
        <span className="text-emerald-400">+{added}</span>
        <span className="text-red-400">−{removed}</span>
      </div>
      <pre className="max-h-96 overflow-auto p-0 font-mono text-xs leading-5">
        {rows.map((r, idx) => (
          <div
            key={idx}
            className={
              r.kind === '+'
                ? 'bg-emerald-950/60 text-emerald-300'
                : r.kind === '-'
                  ? 'bg-red-950/60 text-red-300'
                  : r.kind === '…'
                    ? 'bg-neutral-900 text-neutral-500 italic'
                    : 'text-neutral-400'
            }
          >
            <span className="inline-block w-5 select-none text-center text-neutral-600">
              {r.kind === '…' ? '⋯' : r.kind}
            </span>
            {r.text}
          </div>
        ))}
      </pre>
    </div>
  );
}
