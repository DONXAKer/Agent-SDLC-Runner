/**
 * Автозаполнение механических полей отчёта разведки — тем же приёмом, что журнал chunk'а
 * (`journalAutofill.ts`) и отчёт приёмки (`verifyAutofill.ts`): факты, которые рантайм знает
 * сам, в бланк кладёт рантайм, а не модель. Название витка и одно предложение цели — из
 * задачи; стек и команды — из детекта экосистемы (тот же источник, что у гейтов); гейт
 * «Заполненность артефактов» — из набора. Чистая функция.
 */

import { replaceAfterLabel } from '../artifacts/artifact.ts';
import { fillMechanicalPlaceholders } from './journalAutofill.ts';
import { spliceFieldValue } from '../explore/fields.ts';
import type { EcosystemLine } from '../explore/view.ts';

export interface ExplorationFacts {
  /** Название витка — из заголовка задачи («# Задача: …»), иначе slug. */
  title: string;
  /** Одно предложение о цели — первое предложение «Коротко», обрезанное; `''`/`null` — нет. */
  brief: string | null;
  stack: readonly EcosystemLine[];
  /**
   * `enabled` — гейт «Заполненность артефактов» включён: строка остаётся плейсхолдером до
   * конца конвейера (статус считается ПОСЛЕ заполнения); `debt` — выключен, `⏭ — гейт в
   * долге`; `absent` — строки в наборе нет вовсе: тоже долг, и это сказано в примечании.
   */
  fillednessGate: 'enabled' | 'debt' | 'absent';
}

const TEMPLATE = 'exploration-report.template.md';
const BRIEF_MAX = 160;

/** Название витка из заголовка задачи; `null` — заголовка нет. */
export function titleFromIntent(intentText: string): string | null {
  const m = /^#\s+(?:Задача:\s*)?(.+?)\s*$/m.exec(intentText);
  return m === null ? null : (m[1] ?? '').trim();
}

/** Первое предложение секции «Коротко», без плейсхолдеров; `null` — секции нет или пуста. */
export function briefFromIntent(intentText: string): string | null {
  const m = /^##\s+Коротко\s*$([\s\S]*?)(?=^##\s|\s*$(?![\s\S]))/mi.exec(intentText);
  if (m === null) return null;
  const body = (m[1] ?? '')
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '' && !/^_.*_$/.test(l.trim()) && !l.trim().startsWith('>'))
    .join(' ')
    .replace(/‹[^›]*›/g, '')
    .trim();
  if (body === '') return null;
  const first = /^(.+?[.!?])(\s|$)/.exec(body);
  const sentence = (first?.[1] ?? body).trim();
  return sentence.length > BRIEF_MAX ? `${sentence.slice(0, BRIEF_MAX - 1)}…` : sentence;
}

function stackLabel(stack: readonly EcosystemLine[]): string | null {
  if (stack.length === 0) return null;
  return [...new Set(stack.map((s) => s.label))].join(', ');
}

function commandsLine(stack: readonly EcosystemLine[]): string | null {
  if (stack.length === 0) return null;
  return stack
    .map((s) => {
      const dir = s.dir === '.' ? '' : `\`${s.dir}\`: `;
      const build = s.build === null ? 'сборки нет (язык без компиляции)' : `сборка \`${s.build}\``;
      const test = s.test === null ? 'тесты не запускаются — раннера нет' : `тесты \`${s.test}\``;
      return `${dir}${build}; ${test}`;
    })
    .join(' · ');
}

export function autofillExplorationReport(text: string, facts: ExplorationFacts): { text: string; filled: number } {
  const stack = stackLabel(facts.stack);
  const commands = commandsLine(facts.stack);
  const { text: filledText, filled } = fillMechanicalPlaceholders(text, (inner, line) => {
    if (inner === 'название витка') return facts.title;
    // Пустая цель («Коротко» ещё не заполнено) — `null`, не `''`: `fillMechanicalPlaceholders`
    // трактует `null` как «пропустить», а пустую строку вписал бы НА МЕСТО плейсхолдера,
    // стирая его молча — поле выглядело бы заполненным (плейсхолдера в тексте больше нет),
    // а видимого содержания там нет вовсе (ревью code-review-all, 2026-09-11).
    if (inner.startsWith('одно предложение о цели')) return facts.brief === null || facts.brief === '' ? null : facts.brief;
    if (inner === 'что' && /язык\s*\/\s*стек/i.test(line)) return stack;
    if (inner === 'команды' && /сборка\s*\/\s*тесты/i.test(line)) return commands;
    return null;
  });
  let out = filledText;
  let n = filled;
  if (facts.fillednessGate !== 'enabled') {
    const value =
      facts.fillednessGate === 'debt'
        ? '⏭ — гейт в долге'
        : '⏭ — гейт в долге (строки «Заполненность артефактов» в наборе нет — добавь её в .sdlc/gates.md)';
    // Плейсхолдер — `spliceFieldValue`; повторный проход по уже проставленному статусу
    // (`replaceAfterLabel`, метка вместо схемы) — та же причина, что у `ExploreExecutor`
    // шага 10 (ревью code-review-all, 2026-09-11).
    const spliced = spliceFieldValue(out, TEMPLATE, 'гейт «заполненность артефактов»', value) ?? replaceAfterLabel(out, 'Гейт «Заполненность артефактов»', value);
    if (spliced !== null && spliced !== out) {
      out = spliced;
      n++;
    }
  }
  return { text: out, filled: n };
}
