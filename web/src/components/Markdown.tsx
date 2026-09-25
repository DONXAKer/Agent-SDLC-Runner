import { memo, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import { parseMarkdown } from '../lib/markdown.ts';
import type { Align, Block, Inline } from '../lib/markdown.ts';

/** Ссылка кликабельна только на http(s): `javascript:` из текста модели не исполняется. */
const SAFE_HREF = /^https?:\/\//i;

function InlineView({ nodes }: { nodes: Inline[] }): JSX.Element {
  return (
    <>
      {nodes.map((n, i): ReactNode => {
        switch (n.t) {
          case 'text':
            return <span key={i}>{n.v}</span>;
          case 'code':
            return (
              <code key={i} className="rounded bg-neutral-800/80 px-1 font-mono text-[0.9em] text-sky-200">
                {n.v}
              </code>
            );
          case 'ph':
            return (
              <mark key={i} className="rounded bg-amber-950/70 px-0.5 text-amber-300">
                {n.v}
              </mark>
            );
          case 'strong':
            return (
              <strong key={i} className="font-semibold text-neutral-100">
                <InlineView nodes={n.c} />
              </strong>
            );
          case 'em':
            return (
              <em key={i}>
                <InlineView nodes={n.c} />
              </em>
            );
          case 'del':
            return (
              <del key={i} className="text-neutral-500">
                <InlineView nodes={n.c} />
              </del>
            );
          case 'link':
            return SAFE_HREF.test(n.href) ? (
              <a key={i} href={n.href} target="_blank" rel="noopener noreferrer" className="text-sky-300 underline">
                <InlineView nodes={n.c} />
              </a>
            ) : (
              <span key={i} className="text-sky-300" title={n.href}>
                <InlineView nodes={n.c} />
              </span>
            );
        }
      })}
    </>
  );
}

const HEADING_CLS = [
  'text-base font-semibold text-neutral-100',
  'border-b border-neutral-800 pb-0.5 text-[15px] font-semibold text-neutral-100',
  'text-sm font-semibold text-neutral-100',
  'text-sm font-medium text-neutral-200',
  'text-xs font-medium text-neutral-200',
  'text-xs font-medium text-neutral-400',
];

const ALIGN_CLS: Record<Exclude<Align, null>, string> = { left: 'text-left', center: 'text-center', right: 'text-right' };

function BlocksView({ blocks }: { blocks: Block[] }): JSX.Element {
  return (
    <>
      {blocks.map((b, i): ReactNode => {
        switch (b.t) {
          case 'heading': {
            const Tag = `h${Math.min(Math.max(b.level, 1), 6)}` as 'h1';
            return (
              <Tag key={i} className={`mt-3 first:mt-0 ${HEADING_CLS[b.level - 1] ?? HEADING_CLS[5]}`}>
                <InlineView nodes={b.c} />
              </Tag>
            );
          }
          case 'para':
            return (
              <p key={i} className="mt-2 whitespace-pre-wrap break-words first:mt-0">
                <InlineView nodes={b.c} />
              </p>
            );
          case 'code':
            return (
              <pre
                key={i}
                className="mt-2 overflow-x-auto rounded border border-neutral-800 bg-neutral-950 px-2 py-1.5 font-mono text-[11px] leading-4 text-neutral-300 first:mt-0"
              >
                {b.v}
              </pre>
            );
          case 'nested':
            return (
              <div key={i} className="mt-2 rounded border border-neutral-800 px-3 py-2 first:mt-0">
                <BlocksView blocks={b.blocks} />
              </div>
            );
          case 'list':
            return (
              <ul key={i} className="mt-2 space-y-0.5 first:mt-0">
                {b.items.map((it, k) => (
                  <li key={k} className="flex gap-1.5" style={{ paddingLeft: `${it.depth * 1.25}rem` }}>
                    <span className="shrink-0 select-none text-neutral-500">
                      {it.checked !== null ? (it.checked ? '☑' : '☐') : it.num !== null ? `${it.num}.` : '•'}
                    </span>
                    <span className="min-w-0 whitespace-pre-wrap break-words">
                      <InlineView nodes={it.text} />
                    </span>
                  </li>
                ))}
              </ul>
            );
          case 'table':
            return (
              <div key={i} className="mt-2 overflow-x-auto first:mt-0">
                <table className="border-collapse text-xs">
                  <thead>
                    <tr>
                      {b.head.map((c, k) => (
                        <th
                          key={k}
                          className={`border border-neutral-800 bg-neutral-900 px-2 py-1 font-medium text-neutral-200 ${ALIGN_CLS[b.align[k] ?? 'left']}`}
                        >
                          <InlineView nodes={c} />
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((row, r) => (
                      <tr key={r}>
                        {row.map((c, k) => (
                          <td key={k} className={`border border-neutral-800 px-2 py-1 align-top break-words ${ALIGN_CLS[b.align[k] ?? 'left']}`}>
                            <InlineView nodes={c} />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case 'quote':
            return (
              <blockquote key={i} className="mt-2 border-l-2 border-neutral-700 pl-3 text-neutral-400 first:mt-0">
                <BlocksView blocks={b.blocks} />
              </blockquote>
            );
          case 'comment':
            // Подсказки шаблона не прячутся: по ним видно, что поле ещё не тронуто.
            return (
              <div key={i} className="mt-2 whitespace-pre-wrap break-words text-[11px] italic text-neutral-600 first:mt-0">
                {`<!-- ${b.v} -->`}
              </div>
            );
          case 'hr':
            return <hr key={i} className="my-3 border-neutral-800" />;
        }
      })}
    </>
  );
}

export const Markdown = memo(function Markdown({ text, topLevel = true }: { text: string; /** `false` — фрагмент (промпт, ответ модели), не целый файл: шапка `---…---` в начале не читается как YAML-фронтматтер. */ topLevel?: boolean }): JSX.Element {
  const blocks = useMemo(() => parseMarkdown(text, topLevel), [text, topLevel]);
  return (
    <div className="text-sm leading-relaxed text-neutral-300">
      <BlocksView blocks={blocks} />
    </div>
  );
});

/**
 * Текст с переключателем «markdown / исходник»: разметка читается легче, а исходник нужен,
 * когда важен сам текст файла — лишний пробел, сломанная таблица, экранирование.
 */
export function MarkdownOrSource({
  text,
  source,
  maxHeight = 'max-h-[60vh]',
  topLevel = true,
}: {
  text: string;
  /** Как рисовать исходник. */
  source: ReactNode;
  maxHeight?: string;
  /** См. `Markdown` — `false` для фрагментов (промпт, ответ модели). */
  topLevel?: boolean;
}): JSX.Element {
  const [md, setMd] = useState(true);
  const btn = (active: boolean): string =>
    `rounded px-1.5 py-0.5 ${active ? 'bg-neutral-800 text-neutral-200' : 'text-neutral-500 hover:text-neutral-300'}`;
  return (
    <div>
      <div className="flex justify-end gap-1 border-b border-neutral-800/60 px-2 py-0.5 text-[10px]">
        <button type="button" className={btn(md)} onClick={() => setMd(true)}>
          markdown
        </button>
        <button type="button" className={btn(!md)} onClick={() => setMd(false)}>
          исходник
        </button>
      </div>
      {md ? (
        <div className={`${maxHeight} overflow-auto px-3 py-2`}>
          <Markdown text={text} topLevel={topLevel} />
        </div>
      ) : (
        source
      )}
    </div>
  );
}
