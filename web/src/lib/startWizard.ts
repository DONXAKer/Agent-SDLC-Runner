/**
 * Шаги мастера нового витка.
 *
 * Логика «можно ли дальше» живёт здесь, а не в компоненте: до мастера стартовый экран был
 * одной простынёй, где единственной проверкой был `disabled` на финальной кнопке по
 * пустому slug'у — а правило рецензента клиент показывал текстом и пропускал дальше.
 * Мастер обязан не пускать на следующий шаг с заведомо нестартующим витком, и это правило
 * должно быть проверяемым.
 */

/** Номера шагов: проект → профиль и модели → задача и запуск. */
export type WizardStep = 1 | 2 | 3;

export const WIZARD_STEPS: readonly WizardStep[] = [1, 2, 3];

export const WIZARD_TITLES: Record<WizardStep, string> = {
  1: 'Проект',
  2: 'Профиль и модели',
  3: 'Задача и запуск',
};

export interface WizardState {
  /** Выбран ли проект. Без него нечего слать на сервер. */
  projectChosen: boolean;
  /** Правило рецензента нарушено — `evaluateReviewerRule(...).broken`. */
  ruleBroken: boolean;
  /** Slug витка как его набрал человек, без обрезки. */
  slug: string;
}

/**
 * Почему с этого шага нельзя дальше. `null` — можно.
 *
 * Причина возвращается строкой, а не булевым флагом: заблокированная кнопка, не
 * называющая причину, читается как поломка — тот же урок, что у блокеров этапа.
 */
export function stepBlocker(step: WizardStep, state: WizardState): string | null {
  if (step === 1) return state.projectChosen ? null : 'Проект не выбран';
  if (step === 2) {
    return state.ruleBroken
      ? 'verify не строго сильнее chunk — сервер такой виток не запустит'
      : null;
  }
  return state.slug.trim() === '' ? 'Slug витка не задан' : null;
}

export function canProceed(step: WizardStep, state: WizardState): boolean {
  return stepBlocker(step, state) === null;
}

/** Следующий/предыдущий шаг с упором в границы: за пределы 1..3 мастер не уходит. */
export function nextStep(step: WizardStep): WizardStep {
  return step === 3 ? 3 : ((step + 1) as WizardStep);
}

export function prevStep(step: WizardStep): WizardStep {
  return step === 1 ? 1 : ((step - 1) as WizardStep);
}

/**
 * Открывать ли мастер сразу при заходе на стартовый экран.
 *
 * Продолжать нечего — значит и выбирать не из чего: показывать пустой экран с одной
 * кнопкой «Новый виток» ради лишнего клика незачем.
 */
export function wizardOpenByDefault(runsCount: number, historyCount: number): boolean {
  return runsCount === 0 && historyCount === 0;
}

/**
 * Транслитерация кириллицы для slug'а. Однобуквенные соответствия где можно: слог
 * «х» после согласной читается естественно и без мягкого знака. `ё` схлопывается в
 * `e` — в slug'е различие не работает, а двойное написание ломало бы поиск.
 */
const CYRILLIC: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i',
  й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't',
  у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '',
  э: 'e', ю: 'yu', я: 'ya',
};

/**
 * Slug из текста задачи: транслит → kebab-case из [a-z0-9]. Пустая строка — в тексте
 * не оказалось ни буквы, ни цифры (например, одна пунктуация); вызывающий обязан
 * оставить поле как есть, а не подставлять пустой slug.
 */
export function slugFromText(text: string): string {
  let out = '';
  for (const ch of text.toLowerCase()) {
    out += CYRILLIC[ch] ?? ch;
  }
  return out
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

/**
 * Свободный вариант slug'а: `base` сам, а при занятости — `base-2`, `base-3` и так
 * далее. Считается по истории проекта, поэтому коллизия с прошлым витком ловится
 * до похода на сервер, а не отказом `createRun`.
 */
export function uniqueSlug(base: string, taken: ReadonlySet<string>): string {
  if (base === '' || !taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}
