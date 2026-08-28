/**
 * Декларация семи этапов витка.
 *
 * Три принципа методологии зашиты здесь конструкцией:
 *
 * - «Права выдаются на шаг, а не на прогон» — у каждого этапа свой набор инструментов,
 *   и политика отклоняет всё, что в него не входит.
 * - «Нет артефакта — нет шага» — предусловия проверяются чтением файлов, а не памятью
 *   диалога. Виток, начатый в терминале скиллами `/sdlc-*`, продолжается здесь и наоборот.
 * - «Автор не рецензирует себя» — рецензент этапа 6 получает артефакты и diff, но не
 *   журнал исполнителя: журнал это и есть рассказ о том, как шла работа.
 */

import { DECISION, artifactExists, readArtifact, readDecision } from '../artifacts/artifact.ts';
import type { ArtifactKey, WitokPaths } from '../artifacts/paths.ts';
import { SDLC_DIR } from '../artifacts/paths.ts';
import type { StageId, ToolName } from '@sdlc-runner/shared';

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
  /** Субагенты, которых методология требует именно на этом этапе. */
  subagents: readonly string[];
  produces: (c: StageContext) => string[];
  requires: readonly Precondition[];
  /**
   * Артефакты, которые агент не вправе переписывать на этом этапе: решения человека и
   * конфигурация процесса. Агент, который может переписать одобренный план, может снять
   * с себя любое ограничение.
   */
  protectedArtifacts: (c: StageContext) => string[];
  /**
   * Поле решения человека, без которого следующий этап не начинается.
   *
   * Артефакт назван ключом, а не путём: тот же ключ приходит из интерфейса, когда
   * оператор записывает решение, и путь по нему собирает рантайм.
   */
  humanGate: { artifact: ArtifactKey; label: string } | null;
  /** Причина пропустить этап, либо `null`. */
  skipIf: ((c: StageContext) => string | null) | null;
}

// ── помощники предусловий ──────────────────────────────────────────────────

function exists(describe: string, file: (c: StageContext) => string): Precondition {
  return {
    describe,
    check: (c) => {
      const p = file(c);
      // Существование проверяем stat'ом, а не чтением: раньше сюда уходило по 400 КБ
      // с диска на каждый запрос состояния — патч попытки читался целиком ради булева.
      return artifactExists(p) ? null : `нет файла ${p}`;
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
          return `поле «${label}» в ${a.path}: ${d.why}. Молчание одобрением не считается.`;
        case 'declined':
          return `поле «${label}» в ${a.path} содержит отрицательное решение: ${d.raw}`;
        case 'granted':
          return null;
      }
    },
  };
}

/** Есть ли в тексте незакрытый пункт вида «- [ ] вопрос» в любом написании. */
function hasOpenQuestions(text: string): boolean {
  return /^\s*[-*+]\s*\[\s*\]/m.test(text);
}

/** Мелкий контур: этапы 2 и 3 не запускаются, разведка точечная на этапе 5. */
export function isSmallContour(c: StageContext): boolean {
  const intent = readArtifact(c.paths.intent);
  if (!intent.exists) return false;
  const m = /^.*\*\*Контур:\*\*(.*)$/m.exec(intent.text);
  if (m === null) return false;
  const raw = (m[1] ?? '').replace(/~~[^~]*~~/g, ' ');
  // «полный / мелкий» без вычеркнутого — выбор не сделан, считаем полным контуром.
  const small = /мелк/i.test(raw);
  const full = /полн/i.test(raw);
  return small && !full;
}

/** Отчёт приёмки последней попытки говорит, что виток принят. */
function verificationPassed(c: StageContext): boolean {
  const report = readArtifact(c.paths.verificationReport(c.chunk, c.attempt));
  if (!report.exists) return false;
  return /(^|\s)passed\s*[:=]\s*true/i.test(report.text);
}

const RUNTIME_PROTECTED = (c: StageContext): string[] => [
  `${SDLC_DIR}/gates.md`,
  relOf(c, c.paths.plan),
  relOf(c, c.paths.intent),
];

function relOf(c: StageContext, absolute: string): string {
  const root = c.paths.projectRoot.replace(/\\/g, '/');
  const p = absolute.replace(/\\/g, '/');
  return p.startsWith(`${root}/`) ? p.slice(root.length + 1) : p;
}

// ── этапы ──────────────────────────────────────────────────────────────────

export const STAGES: readonly StageDef[] = [
  {
    id: 'intent',
    skill: 'sdlc-intent',
    title: 'Цель витка',
    // Bash обязателен: скилл заводит ветку витка `sdlc/<slug>` и пересчитывает
    // литеральные примеры приёмки исполнением. Без ветки git diff этапа 5 подхватывает
    // чужую незакоммиченную работу, и scope-гейт краснеет на файлах, которых агент
    // не трогал.
    // `Bash` здесь нет намеренно. Прогон локальных моделей: имея оболочку, модель решает
    // задачу оболочкой — копирует форму в проект и перебирает команды вместо того, чтобы
    // заполнить документ (у 35B двенадцать вызовов из четырнадцати были shell'ом). Этап 1
    // читает, спрашивает человека и пишет артефакт — команда ему не нужна ни для чего.
    tools: ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'AskHuman', 'FinalizeArtifact'],
    subagents: [],
    produces: (c) => [c.paths.gates, c.paths.intent, c.paths.readiness],
    requires: [],
    // На этапе 1 задача и набор гейтов ещё создаются — защищать нечего.
    protectedArtifacts: () => [],
    humanGate: null,
    skipIf: null,
  },

  {
    id: 'explore',
    skill: 'sdlc-explore',
    title: 'Разведка',
    tools: ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Task', 'AskHuman', 'FinalizeArtifact'],
    // Второй агент выводит приёмочный лист вслепую: агент, прочитавший авторский лист,
    // выведет тот же самый, и сверка станет декорацией.
    subagents: ['sdlc-claims'],
    produces: (c) => [c.paths.explorationReport],
    requires: [
      filled('задача заполнена без плейсхолдеров', (c) => c.paths.intent),
      exists('проверка готовности пройдена (прогон 1)', (c) => c.paths.readiness),
    ],
    protectedArtifacts: (c) => [`${SDLC_DIR}/gates.md`, relOf(c, c.paths.plan)],
    humanGate: { artifact: 'exploration', label: DECISION.checklistComplete },
    skipIf: (c) =>
      isSmallContour(c)
        ? 'мелкий контур: разведка точечная на этапе 5, отчёт не пишется'
        : null,
  },

  {
    id: 'ask',
    skill: 'sdlc-ask',
    title: 'Вопросы',
    tools: ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'AskHuman', 'FinalizeArtifact'],
    subagents: [],
    produces: (c) => [c.paths.clarificationReport],
    requires: [
      // На полном контуре разведка обязана быть: без неё «открытых вопросов нет»
      // означает лишь то, что их некому было найти. Пока предусловия не было, этап
      // запускался сразу после первого, читал несуществующий отчёт как пустую строку и
      // штатно «пропускался» — развилки не задавались никому. Мелкий контур разведку не
      // пишет по построению, поэтому там проверка снимается явным ветвлением, как и на
      // этапе 4.
      {
        describe: 'отчёт разведки на месте (либо мелкий контур)',
        check: (c) =>
          isSmallContour(c) || artifactExists(c.paths.explorationReport)
            ? null
            : `нет отчёта разведки ${c.paths.explorationReport}. На полном контуре ` +
              `«открытых вопросов нет» без разведки означает, что искать их было некому.`,
      },
    ],
    protectedArtifacts: RUNTIME_PROTECTED,
    humanGate: null,
    // Условный шаг: нет развилок — нет шага и артефакта.
    skipIf: (c) => {
      if (isSmallContour(c)) return 'мелкий контур: этап не запускается';
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
    // Bash — для `git rev-parse HEAD` в поле «База».
    // Оболочки нет по той же причине, что на этапе 1: план — это документ, а не прогон
    // команд. Разведка, которой нужно смотреть в дерево, идёт этапом раньше и своими
    // инструментами чтения.
    tools: ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'AskHuman', 'FinalizeArtifact'],
    subagents: [],
    produces: (c) => [c.paths.plan, c.paths.readiness],
    requires: [
      {
        describe: 'отчёт разведки на месте (или мелкий контур)',
        check: (c) =>
          isSmallContour(c) || artifactExists(c.paths.explorationReport)
            ? null
            : `нет файла ${c.paths.explorationReport}. На мелком контуре разведка не ` +
              `запускается — тогда пометь это в поле «Контур» задачи.`,
      },
      filled('задача заполнена без плейсхолдеров', (c) => c.paths.intent),
    ],
    // План здесь и создаётся, поэтому защищены только задача и набор гейтов.
    protectedArtifacts: (c) => [`${SDLC_DIR}/gates.md`, relOf(c, c.paths.intent)],
    humanGate: { artifact: 'plan', label: DECISION.approval },
    skipIf: null,
  },

  {
    id: 'chunk',
    skill: 'sdlc-chunk',
    title: 'Chunk',
    tools: [
      'Read',
      'Glob',
      'Grep',
      'Write',
      'Edit',
      'Bash',
      'Task',
      'AskHuman',
      'FinalizeArtifact',
      'RequestScopeExtension',
    ],
    // Точечная разведка места правки — read-only по построению.
    subagents: ['sdlc-locator'],
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
    protectedArtifacts: RUNTIME_PROTECTED,
    humanGate: { artifact: 'journal', label: DECISION.confirmed },
    skipIf: null,
  },

  {
    id: 'verify',
    skill: 'sdlc-verify',
    title: 'Верификация',
    // Оболочки здесь НЕТ, и это следствие двух правок, а не экономия прав: патч
    // перегенерирует рантайм (`run/evidence.ts`), гейты он же прогоняет до рецензента и
    // подклеивает их фактический итог ко входу. Всё, ради чего рецензенту нужна была
    // командная строка, приходит к нему готовым — а замер показал, чем она оборачивается
    // на слабой модели: 7 вызовов из 7 ушли в `Bash`, отчёт остался бланком
    // (`docs/model-runs.md`, этап 6). Проверка утверждений по коду остаётся:
    // `Read`/`Grep`/`Glob` при рецензенте.
    //
    // Edit нужен, чтобы обновить колонку «Итог» строки попытки в журнале chunk'а —
    // без него единственный способ это Write целиком, то есть верификатор переписывает
    // журнал исполнителя своей реконструкцией и уничтожает улику этапа 5.
    tools: ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Task', 'AskHuman', 'FinalizeArtifact'],
    subagents: ['sdlc-reviewer'],
    produces: (c) => [c.paths.verificationReport(c.chunk, c.attempt)],
    requires: [
      exists('журнал chunk’а на месте', (c) => c.paths.chunkJournal(c.chunk)),
      exists('патч попытки на месте', (c) => c.paths.chunkDiff(c.chunk, c.attempt)),
      exists('набор гейтов проекта на месте', (c) => c.paths.gates),
      granted(
        'место правки подтверждено человеком',
        (c) => c.paths.chunkJournal(c.chunk),
        DECISION.confirmed,
      ),
    ],
    protectedArtifacts: RUNTIME_PROTECTED,
    humanGate: null,
    skipIf: null,
  },

  {
    id: 'handoff',
    skill: 'sdlc-handoff',
    title: 'Передача',
    tools: ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash', 'AskHuman', 'FinalizeArtifact'],
    subagents: [],
    produces: (c) => [c.paths.handoff],
    requires: [
      // Методология требует на входе вердикт passed=true и приёмку человека. Handoff
      // при этом пишется и при обрыве витка — но обрыв это осознанное решение оператора,
      // а не то, во что можно свалиться, дёрнув этап из любого состояния. Поэтому обрыв
      // разрешается явным флагом, а по умолчанию нужен зелёный отчёт приёмки.
      {
        describe: 'отчёт приёмки с passed=true (или явно объявленный обрыв витка)',
        check: (c) => {
          if (verificationPassed(c)) return null;
          const report = c.paths.verificationReport(c.chunk, c.attempt);
          return artifactExists(report)
            ? `вердикт в ${report} не passed=true. Коммит из этого состояния методология ` +
                `запрещает: возврат на доработку или эскалация, но не передача. Чтобы ` +
                `оформить обрыв витка, запусти этап с флагом «обрыв».`
            : `нет отчёта приёмки ${report}. Передача без вердикта возможна только как ` +
                `обрыв витка — запусти этап с флагом «обрыв».`;
        },
      },
    ],
    // gates.md здесь править можно: методология велит дописывать сюда строку долга.
    protectedArtifacts: (c) => [relOf(c, c.paths.plan), relOf(c, c.paths.intent)],
    humanGate: { artifact: 'handoff', label: DECISION.accepted },
    skipIf: null,
  },
];

export function stageById(id: StageId): StageDef {
  const s = STAGES.find((x) => x.id === id);
  if (s === undefined) throw new Error(`неизвестный этап: ${id}`);
  return s;
}

export function isStageId(v: unknown): v is StageId {
  return typeof v === 'string' && STAGES.some((s) => s.id === v);
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
 * Этап 6 отдельно: журнала chunk'а здесь нет. Журнал — это рассказ исполнителя («что
 * чинили, что изменилось против предыдущей попытки»), а методология перечисляет входы
 * рецензента исчерпывающе: задача, план, набор гейтов и diff. Связь с предыдущей попыткой
 * несут только `retry_instruction` и `carry_forward`, и их подаёт машина витка, а не файл.
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
      return [req(p.intent), opt(p.explorationReport)];
    case 'plan':
      return [
        req(p.intent),
        req(p.readiness),
        opt(p.explorationReport),
        opt(p.clarificationReport),
      ];
    case 'chunk':
      return [
        req(p.plan),
        opt(p.chunkJournal(c.chunk)),
        // Предыдущие попытки существуют только начиная со второй: на первой этих путей
        // нет и быть не может, и просить `attempt-0` бессмысленно.
        ...(c.attempt > 1 ? [opt(p.chunkDiff(c.chunk, c.attempt - 1))] : []),
        ...(c.attempt > 2 ? [opt(p.chunkDiff(c.chunk, c.attempt - 2))] : []),
      ];
    case 'verify':
      return [
        req(p.intent),
        req(p.plan),
        req(p.gates),
        req(p.chunkDiff(c.chunk, c.attempt)),
        opt(p.chunkTests(c.chunk, c.attempt)),
      ];
    case 'handoff':
      return [
        req(p.intent),
        req(p.plan),
        req(p.gates),
        opt(p.verificationReport(c.chunk, c.attempt)),
        opt(p.chunkJournal(c.chunk)),
      ];
  }
}

export interface PreconditionReport {
  ok: boolean;
  /** Причины, по которым этап не начинается. Собираются все сразу. */
  problems: string[];
  /** Причина пропустить этап, если он условный. */
  skip: string | null;
}

export interface PreconditionOptions {
  /** Оператор объявил обрыв витка: handoff оформляет передачу без зелёного вердикта. */
  abortHandoff?: boolean;
}

export function checkPreconditions(
  stage: StageDef,
  c: StageContext,
  opts: PreconditionOptions = {},
): PreconditionReport {
  const problems: string[] = [];

  const skipVerdictCheck = stage.id === 'handoff' && opts.abortHandoff === true;
  for (const p of stage.requires) {
    if (skipVerdictCheck) continue;
    const problem = p.check(c);
    if (problem !== null) problems.push(problem);
  }

  const skip = problems.length === 0 && stage.skipIf !== null ? stage.skipIf(c) : null;
  return { ok: problems.length === 0, problems, skip };
}
