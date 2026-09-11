/**
 * Блок индекса в промпте. Режется по БАЙТАМ в порядке приоритета: кандидаты и символы
 * держатся целиком, дерево и шапка README обрезаются первыми — с честной пометкой, как у
 * prefetch файлов плана. Потолки — по флоу: локальной модели на 16–32k хватает 8 КБ, сильной
 * на sdk можно дать больше.
 */

import { capBytes } from '../prompt/bytes.ts';
import type { ExploreIndexView } from './view.ts';

export const INDEX_BLOCK_BYTES = { loop: 8_000, sdk: 16_000 } as const;

const CUT_NOTE = '…[обрезано рантаймом: потолок блока индекса]';

function stackLines(v: ExploreIndexView): string[] {
  if (v.stack.length === 0) return [];
  return [
    '### Стек и команды (из детекта экосистемы, тем же источником, что у гейтов)',
    ...v.stack.map(
      (m) =>
        `- \`${m.dir}\` (${m.label}): сборка ${m.build === null ? 'нет — язык без компиляции' : `\`${m.build}\``}, ` +
        `тесты ${m.test === null ? 'НЕ ЗАПУСКАЮТСЯ — раннера нет' : `\`${m.test}\``}`,
    ),
  ];
}

function candidateLines(v: ExploreIndexView): string[] {
  if (v.candidates.length === 0) return ['### Файлы-кандидаты', '', '- по ключевым словам задачи ничего не нашлось: назови файлы сама по дереву ниже'];
  return [
    '### Файлы-кандидаты (по ключевым словам задачи, сверху самые вероятные)',
    ...v.candidates.map(
      (c, i) =>
        `${i + 1}. \`${c.path}\` — ${c.lines} строк, ${c.kind === 'test' ? 'тест' : 'код'}; ` +
        `символы: ${c.symbols.length === 0 ? '(разбор не нашёл)' : c.symbols.join(', ')}; почему: ${c.why.join('; ')}`,
    ),
  ];
}

function reuseLines(v: ExploreIndexView): string[] {
  if (v.reuse.length === 0) return [];
  return [
    '### Кандидаты на переиспользование (`путь:символ` — сигнатура — вызывающих)',
    ...v.reuse.map((r) => `- \`${r.path}:${r.symbol}\` — \`${r.signature}\` — ${r.callers}${r.why.length > 0 ? `; ${r.why.join(', ')}` : ''}`),
  ];
}

function axesLines(v: ExploreIndexView): string[] {
  if (v.axes === null) return [];
  const lines = ['### Кандидаты механизмов по осям (для «Опор осей»; пусто — кандидатов не видно, «нет механизма» законен)'];
  for (const [axis, hits] of Object.entries(v.axes)) {
    lines.push(`- ${axis}: ${hits.length === 0 ? '—' : hits.map((h) => `\`${h.path}:${h.symbol ?? `строка ${h.line}`}\``).join(', ')}`);
  }
  return lines;
}

function treeLines(v: ExploreIndexView): string[] {
  const lines = [`### Дерево исходников (${v.treeTotal} файлов${v.skipped.files > 0 ? `, ещё ${v.skipped.files} не вошли по потолку` : ''})`];
  for (const t of v.tree) lines.push(`- \`${t.path}\` (${t.lines})`);
  return lines;
}

/** Собирает блок под потолок: обязательные части целиком, дерево и README — по остатку. */
export function renderIndexBlock(v: ExploreIndexView, maxBytes: number): string {
  const mandatory = [...stackLines(v), '', ...candidateLines(v), '', ...reuseLines(v), '', ...axesLines(v)].join('\n').trim();
  const mandatoryBytes = Buffer.byteLength(mandatory, 'utf8');
  if (mandatoryBytes >= maxBytes) {
    const cut = capBytes(mandatory, Math.max(0, maxBytes - Buffer.byteLength(`\n${CUT_NOTE}`, 'utf8')));
    return `${cut.text}\n${CUT_NOTE}`;
  }
  let rest = maxBytes - mandatoryBytes;
  const parts = [mandatory];

  // Пометка обрезки входит в бюджет, а не добавляется сверх него: потолок — обещание
  // вызывающему, и «8 000 плюс хвост» его нарушало бы на каждом обрезанном блоке.
  const noteBytes = Buffer.byteLength(`\n${CUT_NOTE}`, 'utf8');
  const fit = (text: string, budget: number): string | null => {
    const cut = capBytes(text, Math.max(0, budget - 2 - noteBytes));
    if (cut.text.trim() === '') return null;
    return cut.capped ? `${cut.text}\n${CUT_NOTE}` : cut.text;
  };

  const tree = fit(treeLines(v).join('\n'), rest);
  if (tree !== null) {
    parts.push(tree);
    rest -= Buffer.byteLength(tree, 'utf8') + 2;
  }

  if (v.readmeHead !== null && rest > 200) {
    const readme = fit(`### README (первые строки)\n${v.readmeHead}`, rest);
    if (readme !== null) parts.push(readme);
  }
  return parts.join('\n\n');
}
