import { z } from 'zod';
import { isSeparatorRow, splitRow, escapeCell } from '../md/table.ts';
import { parseGuidedJson } from './guidedJson.ts';
import { plainQuestion } from './guidedProtocol.ts';

export function sourceLineFacts(text: string) {
  return text.split('\n').map((value, index) => ({ number: index + 1, value }));
}

/** Keep original line numbers for runtime citations, replace display rows with data. */
export function contractLineFacts(text: string): { number: number; value: unknown }[] {
  let headers: string[] = [];
  return text.split(/\r?\n/u).flatMap((line, index) => {
    if (!line.trim() || /^\s*<!--/u.test(line) || isSeparatorRow(line)) return [];
    let value: unknown = plainQuestion(line);
    if (line.trim().startsWith('|')) {
      const cells = splitRow(line).map(plainQuestion);
      if (!headers.length) { headers = cells; value = { columns: headers }; }
      else value = Object.fromEntries(cells.map((cell, i) => [headers[i] ?? String(i), cell]));
    } else if (/^\s*[\[{]/u.test(line)) {
      try { value = JSON.parse(line); } catch { /* prose */ }
    }
    return [{ number: index + 1, value }];
  });
}

const sentence = z.string().trim().min(1).max(600);
const id = z.string().regex(/^claim-\d+$/u);
const Acceptance = z.object({ id, behavior: sentence, procedure: sentence, expected: sentence }).strict();
const Basis = z.object({ id, basis: z.object({ file: z.string().regex(/^request-\d+$/u),
  lines: z.tuple([z.number().int().positive(), z.number().int().positive()]) }).strict(), scenario: sentence, counterexample: sentence }).strict();
const valueSchema = (section: string) => section === 'Приёмочный лист' ? Acceptance : section === 'Основания и сценарии' ? Basis : sentence;

export function guidedContractRepairFormat(section: string) {
  const schema = z.toJSONSchema(z.object({ section: z.literal(section), values: z.array(valueSchema(section)).min(1).max(24) }).strict());
  return { type: 'json_schema', json_schema: { name: 'guided_contract_repair', strict: true, schema } };
}

/** Models supply values; only the runtime creates table headers, bullets and citations. */
export function renderGuidedContractRepair(section: string, answer: string, requests: readonly string[], expectedIds?: readonly string[], currentSection?: string): string {
  const parsed = z.object({ section: z.literal(section), values: z.array(valueSchema(section)).min(1).max(24) }).strict().parse(parseGuidedJson(answer));
  const row = (cells: string[]) => `| ${cells.map(escapeCell).join(' | ')} |`;
  if (expectedIds?.length && (section === 'Приёмочный лист' || section === 'Основания и сценарии')) {
    const actual = parsed.values.map(value => (value as { id: string }).id);
    if (actual.length !== expectedIds.length || expectedIds.some(id => !actual.includes(id))) throw new Error('Ремонт меняет набор ID требований');
  }
  if (section === 'Приёмочный лист') {
    const rows = parsed.values.map(value => Acceptance.parse(value));
    if (new Set(rows.map(value => value.id)).size !== rows.length) throw new Error('Повторный ID приёмки');
    if (currentSection?.includes('sdlc-json:acceptance:start')) {
      return currentSection.trim().replace(/(<!--\s*sdlc-json:acceptance:start\s*-->)[\s\S]*?(<!--\s*sdlc-json:acceptance:end\s*-->)/u,
        (_, start: string, end: string) => `${start}\n${JSON.stringify(rows, null, 2)}\n${end}`);
    }
    return ['| ID | Пункт | Как проверить (процедура + критерий) |', '|---|---|---|',
      ...rows.map(value => row([value.id, value.behavior, `Процедура: ${value.procedure}. Ожидаемо: ${value.expected}`]))].join('\n');
  }
  if (section === 'Основания и сценарии') {
    const rows = parsed.values.map(value => Basis.parse(value));
    if (new Set(rows.map(value => value.id)).size !== rows.length) throw new Error('Повторный ID основания');
    // Проверяем ссылки до любого рендера: сохранение JSON не отменяет проверки границ.
    for (const value of rows) {
      const text = requests[Number(value.basis.file.slice('request-'.length)) - 1];
      const [from, to] = value.basis.lines;
      if (text === undefined || to < from || to > text.split('\n').length) throw new Error('Основание ремонта вне источника');
    }
    if (currentSection?.includes('sdlc-json:basis:start')) {
      return currentSection.trim().replace(/(<!--\s*sdlc-json:basis:start\s*-->)[\s\S]*?(<!--\s*sdlc-json:basis:end\s*-->)/u,
        (_, start: string, end: string) => `${start}\n${JSON.stringify(rows, null, 2)}\n${end}`);
    }
    return ['| Основание | Сценарий | Контрпример | ID |', '|---|---|---|---|', ...rows.map(value => {
      const source = Number(value.basis.file.slice('request-'.length)) - 1;
      const text = requests[source]; const [from, to] = value.basis.lines;
      if (text === undefined || to < from || to > text.split('\n').length) throw new Error('Основание ремонта вне источника');
      const quote = text.split('\n').slice(from - 1, to).join('\n');
      return row([`${value.basis.file}:L${from}-L${to} «${quote}»`, value.scenario, value.counterexample, value.id]);
    })].join('\n');
  }
  return parsed.values.map(value => `- ${sentence.parse(value).replace(/\r?\n/gu, ' ')}`).join('\n');
}
