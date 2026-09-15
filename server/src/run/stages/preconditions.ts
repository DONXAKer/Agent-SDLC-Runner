/**
 * Помощники предусловий, общие для нескольких этапов: существование и заполненность
 * артефакта, решение человека, контур витка и минимум приёмочного листа.
 */

import { artifactExists, countPlaceholdersExceptSections, pathIsDirectory, readArtifact, readDecision } from '../../artifacts/artifact.ts';
import { CLAIMS_MINIMUM, countClaims } from '../../artifacts/claims.ts';
import { SDLC_DIR } from '../../artifacts/paths.ts';
import type { Precondition, StageContext } from './types.ts';

// ── помощники предусловий ──────────────────────────────────────────────────

export function exists(describe: string, file: (c: StageContext) => string): Precondition {
  return {
    describe,
    artifact: file,
    check: (c) => {
      const p = file(c);
      // Существование проверяем stat'ом, а не чтением: раньше сюда уходило по 400 КБ
      // с диска на каждый запрос состояния — патч попытки читался целиком ради булева.
      return artifactExists(p) ? null : `нет файла ${p}`;
    },
  };
}

export function filled(describe: string, file: (c: StageContext) => string): Precondition {
  return {
    describe,
    artifact: file,
    check: (c) => {
      const a = readArtifact(file(c));
      if (!a.exists) {
        return pathIsDirectory(a.path)
          ? `по пути ${a.path} лежит каталог, а не файл артефакта`
          : `нет файла ${a.path}`;
      }
      if (a.placeholders > 0) {
        return `в ${a.path} осталось незаполненных мест: ${a.placeholders} — артефакт не готов`;
      }
      return null;
    },
  };
}

/**
 * Секция задачи, которую заполняет разведка, а не этап 1. Имя одно на всех потребителей:
 * страж `intent` её ИСКЛЮЧАЕТ, страж `explore` — наоборот, требует; разойдись эти две
 * строки хоть буквой, и секция выпала бы из обеих проверок разом.
 */
export const TOUCH_SECTION = 'Что придётся тронуть';

/** Незакрытые места задачи вне законно пустой на первом проходе «Что придётся тронуть». */
export function intentPlaceholdersOutsideTouch(text: string): number {
  return countPlaceholdersExceptSections(text, [TOUCH_SECTION]);
}

/**
 * Вариант `filled` для входа в разведку: секция «Что придётся тронуть» интента законно
 * пустая на первом проходе — её заполняет сама разведка (см. `countPlaceholdersExceptSections`).
 */
export function filledExceptTouchSection(describe: string, file: (c: StageContext) => string): Precondition {
  return {
    describe,
    artifact: file,
    check: (c) => {
      const a = readArtifact(file(c));
      if (!a.exists) return `нет файла ${a.path}`;
      const n = intentPlaceholdersOutsideTouch(a.text);
      if (n > 0) return `в ${a.path} осталось незаполненных мест: ${n} — артефакт не готов`;
      return null;
    },
  };
}

/** Причины «решения нет», за которые отвечает человек, а не модель этапа-производителя. */
const HUMAN_PENDING_WHY: ReadonlySet<string> = new Set([
  'поле не заполнено',
  'решение отложено',
  'в поле остались оба исхода — человек не вычеркнул лишний',
]);

export function granted(
  describe: string,
  file: (c: StageContext) => string,
  label: string,
): Precondition {
  return {
    describe,
    // Виноват этап-производитель, когда формы нет, в ней нет поля решения или значение поля
    // испорчено (непустое, но не форма решения: «Подтвердил: ✅», «одобрено» без даты) —
    // человек пишет решение через `setDecision`, а он даёт валидную форму всегда. Пустое,
    // отложенное или отрицательное решение — дело человека, и `ok⚠` у этапа, чья модель
    // ничего не нарушила, отправил бы разбор отказа не туда.
    artifact: (c) => {
      const a = readArtifact(file(c));
      if (!a.exists) return file(c);
      const d = readDecision(a.text, label);
      if (d.state === 'missing') return file(c);
      return d.state === 'placeholder' && d.why !== undefined && !HUMAN_PENDING_WHY.has(d.why) ? file(c) : null;
    },
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
export function hasOpenQuestions(text: string): boolean {
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

/**
 * Минимум приёмочного листа задачи — конструкцией, а не самопроверкой модели.
 *
 * Правило этапа 1 («полный контур: пунктов ≥ 3, из них ≥ 2 с [edge]») держалось только
 * на галочках, которые модель ставила сама себе в readiness.md. Живой прогон: интент-модель
 * сжала входную задачу с четырьмя клеймами до одного — и сама же отчиталась «готова».
 * Проверка на входе в разведку останавливает такой лист до того, как он съест этапы 2–6.
 * На мелком контуре минимум — один пункт (норма методологии «Мелкий виток»).
 */
export function claimsMinimum(): Precondition {
  return {
    describe: 'приёмочный лист не короче минимума этапа 1',
    artifact: (c) => c.paths.intent,
    check: (c) => {
      const intent = readArtifact(c.paths.intent);
      if (!intent.exists) return `нет файла ${c.paths.intent}`;
      // Подсчёт — общим `countClaims` (ячейка id канонически несёт и теги: `claim-1 [edge]`;
      // прежний локальный regex требовал голый `claim-N` и блокировал разведку на
      // полностью правильном intent.md).
      const { rows, edges } = countClaims(intent.text);
      const small = isSmallContour(c);
      const needRows = small ? 1 : CLAIMS_MINIMUM.rows;
      const needEdges = small ? 0 : CLAIMS_MINIMUM.edges;
      if (rows < needRows || edges < needEdges) {
        return (
          `приёмочный лист короче минимума этапа 1: пунктов ${rows} (нужно ≥ ${needRows}), ` +
          `с [edge] ${edges} (нужно ≥ ${needEdges}) — верни недостающие пункты в intent.md ` +
          `(если задача принесла свой лист, из него ничего не выбрасывается без решения человека)`
        );
      }
      return null;
    },
  };
}

export const RUNTIME_PROTECTED = (c: StageContext): string[] => [
  `${SDLC_DIR}/gates.md`,
  relOf(c, c.paths.plan),
  relOf(c, c.paths.intent),
];

export function relOf(c: StageContext, absolute: string): string {
  const root = c.paths.projectRoot.replace(/\\/g, '/');
  const p = absolute.replace(/\\/g, '/');
  return p.startsWith(`${root}/`) ? p.slice(root.length + 1) : p;
}
