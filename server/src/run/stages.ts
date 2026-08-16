/**
 * Декларация семи этапов витка.
 *
 * Два принципа методологии зашиты здесь конструкцией:
 *
 * - «Права выдаются на шаг, а не на прогон» — у каждого этапа свой набор инструментов,
 *   и политика отклоняет всё, что в него не входит.
 * - «Нет артефакта — нет шага» — предусловия проверяются чтением файлов, а не памятью
 *   диалога. Виток, начатый в терминале скиллами `/sdlc-*`, продолжается здесь и наоборот.
 */

import { DECISION, readArtifact, readDecision } from '../artifacts/artifact.ts';
import type { WitokPaths } from '../artifacts/paths.ts';
import type { StageId, ToolName } from '../types.ts';

export interface StageContext {
  paths: WitokPaths;
  /** Номер chunk'а витка, с 1. */
  chunk: number;
  /** Номер попытки текущего chunk'а, с 1. */
  attempt: number;
}

export interface Precondition {
  /** Что требуется — показывается оператору как есть. */
  describe: string;
  /** `null` — выполнено; строка — причина, по которой этап не начинается. */
  check: (c: StageContext) => string | null;
}

export interface StageDef {
  id: StageId;
  /** Каталог скилла в `runner.skillsDir`, откуда берётся тело системного промпта. */
  skill: string;
  title: string;
  tools: readonly ToolName[];
  produces: (c: StageContext) => string[];
  requires: readonly Precondition[];
  /** Поле решения человека, без которого следующий этап не начинается. */
  humanGate: { file: (c: StageContext) => string; label: string } | null;
  /** Причина пропустить этап, либо `null`. Этап 3 условный: нет развилок — нет шага. */
  skipIf: ((c: StageContext) => string | null) | null;
}

// ── помощники предусловий ──────────────────────────────────────────────────

function exists(describe: string, file: (c: StageContext) => string): Precondition {
  return {
    describe,
    check: (c) => {
      const p = file(c);
      return readArtifact(p).exists ? null : `нет файла ${p}`;
    },
  };
}

function filled(describe: string, file: (c: StageContext) => string): Precondition {
  return {
    describe,
    check: (c) => {
      const a = readArtifact(file(c));
      if (!a.exists) return `нет файла ${a.path}`;
      if (a.placeholders > 0) {
        return `в ${a.path} осталось незаполненных мест: ${a.placeholders} — артефакт не готов`;
      }
      return null;
    },
  };
}

function granted(
  describe: string,
  file: (c: StageContext) => string,
  label: string,
): Precondition {
  return {
    describe,
    check: (c) => {
      const a = readArtifact(file(c));
      if (!a.exists) return `нет файла ${a.path}`;
      const d = readDecision(a.text, label);
      switch (d.state) {
        case 'missing':
          return `в ${a.path} нет поля «${label}» — форма не соответствует шаблону методологии`;
        case 'placeholder':
          return `поле «${label}» в ${a.path} не заполнено. Молчание одобрением не считается.`;
        case 'declined':
          return `поле «${label}» в ${a.path} содержит отрицательное решение: ${d.raw}`;
        case 'granted':
          return null;
      }
    },
  };
}

/** Есть ли в тексте незакрытый пункт вида «- [ ] вопрос». */
function hasOpenQuestions(text: string): boolean {
  return /^\s*-\s*\[ \]/m.test(text);
}

// ── этапы ──────────────────────────────────────────────────────────────────

export const STAGES: readonly StageDef[] = [
  {
    id: 'intent',
    skill: 'sdlc-intent',
    title: 'Цель витка',
    // Команды сборки и тестов скилл добывает сам из манифестов проекта — отсюда Read/Glob/Grep.
    tools: ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'AskHuman'],
    produces: (c) => [c.paths.gates, c.paths.intent, c.paths.readiness],
    requires: [],
    humanGate: null,
    skipIf: null,
  },

  {
    id: 'explore',
    skill: 'sdlc-explore',
    title: 'Разведка',
    // Разведка ничего не меняет в коде: пишет только свой отчёт и секцию «Что придётся
    // тронуть» в задаче.
    tools: ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'AskHuman'],
    produces: (c) => [c.paths.explorationReport],
    requires: [
      filled('задача заполнена без плейсхолдеров', (c) => c.paths.intent),
      exists('проверка готовности пройдена (прогон 1)', (c) => c.paths.readiness),
    ],
    humanGate: { file: (c) => c.paths.explorationReport, label: DECISION.checklistComplete },
    skipIf: null,
  },

  {
    id: 'ask',
    skill: 'sdlc-ask',
    title: 'Вопросы',
    tools: ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'AskHuman'],
    produces: (c) => [c.paths.clarificationReport],
    requires: [exists('отчёт разведки на месте', (c) => c.paths.explorationReport)],
    humanGate: null,
    // Условный шаг: нет развилок — нет шага и артефакта.
    skipIf: (c) => {
      const intent = readArtifact(c.paths.intent);
      const expl = readArtifact(c.paths.explorationReport);
      const open = hasOpenQuestions(intent.text) || hasOpenQuestions(expl.text);
      return open ? null : 'открытых вопросов нет — этап условный, артефакт не создаётся';
    },
  },

  {
    id: 'plan',
    skill: 'sdlc-plan',
    title: 'План витка',
    // Bash нужен ровно для `git rev-parse HEAD` — поле «База» плана.
    tools: ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash', 'AskHuman'],
    produces: (c) => [c.paths.plan, c.paths.readiness],
    requires: [
      exists('отчёт разведки на месте', (c) => c.paths.explorationReport),
      filled('задача заполнена без плейсхолдеров', (c) => c.paths.intent),
    ],
    humanGate: { file: (c) => c.paths.plan, label: DECISION.approval },
    skipIf: null,
  },

  {
    id: 'chunk',
    skill: 'sdlc-chunk',
    title: 'Chunk',
    tools: ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash', 'AskHuman'],
    produces: (c) => [
      c.paths.chunkJournal(c.chunk),
      c.paths.chunkDiff(c.chunk, c.attempt),
      c.paths.chunkTests(c.chunk, c.attempt),
    ],
    requires: [
      // Без заполненного поля одобрения chunk не начинается — так требует методология,
      // и проверяется именно поле в файле, а не память диалога.
      granted('план одобрен человеком', (c) => c.paths.plan, DECISION.approval),
    ],
    humanGate: { file: (c) => c.paths.chunkJournal(c.chunk), label: DECISION.confirmed },
    skipIf: null,
  },

  {
    id: 'verify',
    skill: 'sdlc-verify',
    title: 'Верификация',
    // Bash здесь обязателен: diff перегенерируется из дерева, гейты прогоняются заново.
    tools: ['Read', 'Glob', 'Grep', 'Write', 'Bash', 'AskHuman'],
    produces: (c) => [c.paths.verificationReport(c.chunk, c.attempt)],
    requires: [
      exists('журнал chunk’а на месте', (c) => c.paths.chunkJournal(c.chunk)),
      exists('патч попытки на месте', (c) => c.paths.chunkDiff(c.chunk, c.attempt)),
      granted(
        'место правки подтверждено человеком',
        (c) => c.paths.chunkJournal(c.chunk),
        DECISION.confirmed,
      ),
    ],
    humanGate: null,
    skipIf: null,
  },

  {
    id: 'handoff',
    skill: 'sdlc-handoff',
    title: 'Передача',
    tools: ['Read', 'Glob', 'Grep', 'Write', 'Bash', 'AskHuman'],
    produces: (c) => [c.paths.handoff],
    // Отчёта приёмки может не быть при обрыве витка — handoff пишется всегда, в том числе
    // при исчерпанном бюджете и неодобренном плане, поэтому предусловий здесь нет.
    requires: [],
    humanGate: { file: (c) => c.paths.handoff, label: DECISION.accepted },
    skipIf: null,
  },
];

export function stageById(id: StageId): StageDef {
  const s = STAGES.find((x) => x.id === id);
  if (s === undefined) throw new Error(`неизвестный этап: ${id}`);
  return s;
}

export interface PreconditionReport {
  ok: boolean;
  /** Причины, по которым этап не начинается. Собираются все сразу. */
  problems: string[];
  /** Причина пропустить этап, если он условный. */
  skip: string | null;
}

export interface StageInput {
  path: string;
  /** Необязательный вход: отсутствие файла не мешает этапу. */
  optional: boolean;
}

/**
 * Артефакты, которые этап читает на входе. Они подклеиваются в пользовательское сообщение
 * целиком: методология требует, чтобы этап работал по файлам, а не по пересказу
 * предыдущего этапа.
 *
 * Отдельный случай — этап 6: рецензенту НЕ передаётся ни рассказ исполнителя, ни история
 * его вызовов. Это обеспечивается тем, что здесь перечислены только артефакты.
 */
export function stageInputs(id: StageId, c: StageContext): StageInput[] {
  const p = c.paths;
  const req = (path: string): StageInput => ({ path, optional: false });
  const opt = (path: string): StageInput => ({ path, optional: true });

  switch (id) {
    case 'intent':
      return [opt(p.gates)];
    case 'explore':
      return [req(p.intent), req(p.readiness), opt(p.gates)];
    case 'ask':
      return [req(p.intent), req(p.explorationReport)];
    case 'plan':
      return [
        req(p.intent),
        req(p.readiness),
        req(p.explorationReport),
        opt(p.clarificationReport),
      ];
    case 'chunk':
      return [
        req(p.plan),
        opt(p.chunkJournal(c.chunk)),
        // Связь с предыдущей попыткой несут только retry_instruction и carry_forward
        // из отчёта приёмки — сам отчёт целиком исполнителю не подаётся.
        opt(p.chunkDiff(c.chunk, c.attempt - 1)),
        opt(p.chunkDiff(c.chunk, c.attempt - 2)),
      ];
    case 'verify':
      return [
        req(p.intent),
        req(p.plan),
        req(p.gates),
        req(p.chunkJournal(c.chunk)),
        req(p.chunkDiff(c.chunk, c.attempt)),
        opt(p.chunkTests(c.chunk, c.attempt)),
      ];
    case 'handoff':
      return [
        req(p.intent),
        req(p.plan),
        opt(p.verificationReport(c.chunk, c.attempt)),
        opt(p.chunkJournal(c.chunk)),
      ];
  }
}

export function checkPreconditions(stage: StageDef, c: StageContext): PreconditionReport {
  const problems: string[] = [];
  for (const p of stage.requires) {
    const problem = p.check(c);
    if (problem !== null) problems.push(problem);
  }
  const skip = problems.length === 0 && stage.skipIf !== null ? stage.skipIf(c) : null;
  return { ok: problems.length === 0, problems, skip };
}
