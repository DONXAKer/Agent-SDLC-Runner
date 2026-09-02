/**
 * Раскладка артефактов витка.
 *
 * `.sdlc/gates.md` — файл проекта (набор гейтов, меняется раз в месяцы).
 * `.sdlc/<slug>/` — артефакты одного витка.
 *
 * Имена файлов канонические: их читают и существующие `/sdlc-*` скиллы Claude Code,
 * так что виток, начатый здесь, можно продолжить в терминале и наоборот.
 */

import { join } from 'node:path';

export const SDLC_DIR = '.sdlc';

/**
 * Короткие имена артефактов витка.
 *
 * Нужны там, где артефакт называет не код, а внешний мир: интерфейс просит записать
 * решение в «plan», а не в путь. Путь рантайм собирает сам — иначе поле решения можно
 * было бы записать в произвольный файл на диске, в том числе в чужой виток.
 */
export type ArtifactKey =
  | 'intent'
  | 'readiness'
  | 'exploration'
  | 'clarification'
  | 'plan'
  | 'journal'
  | 'verification'
  | 'iterations'
  | 'selfReview'
  | 'handoff';

const ARTIFACT_KEYS: readonly string[] = [
  'intent',
  'readiness',
  'exploration',
  'clarification',
  'plan',
  'journal',
  'verification',
  'iterations',
  'selfReview',
  'handoff',
];

export function isArtifactKey(v: string): v is ArtifactKey {
  return ARTIFACT_KEYS.includes(v);
}

export function artifactPathOf(
  paths: WitokPaths,
  key: ArtifactKey,
  chunk: number,
  attempt: number,
): string {
  switch (key) {
    case 'intent':
      return paths.intent;
    case 'readiness':
      return paths.readiness;
    case 'exploration':
      return paths.explorationReport;
    case 'clarification':
      return paths.clarificationReport;
    case 'plan':
      return paths.plan;
    case 'journal':
      return paths.chunkJournal(chunk);
    case 'verification':
      return paths.verificationReport(chunk, attempt);
    case 'iterations':
      return paths.iterations;
    case 'selfReview':
      return paths.selfReview(chunk, attempt);
    case 'handoff':
      return paths.handoff;
  }
}

export class WitokPaths {
  readonly projectRoot: string;
  readonly slug: string;

  constructor(projectRoot: string, slug: string) {
    this.projectRoot = projectRoot;
    this.slug = slug;
  }

  /** Набор гейтов — общий для проекта, не для витка. */
  get gates(): string {
    return join(this.projectRoot, SDLC_DIR, 'gates.md');
  }

  /** Журнал калибровки посевом — тоже проектный, живёт вне витка. */
  get seedLog(): string {
    return join(this.projectRoot, SDLC_DIR, 'seed-log.md');
  }

  get dir(): string {
    return join(this.projectRoot, SDLC_DIR, this.slug);
  }

  private file(name: string): string {
    return join(this.dir, name);
  }

  get intent(): string {
    return this.file('intent.md');
  }

  get readiness(): string {
    return this.file('readiness.md');
  }

  get explorationReport(): string {
    return this.file('exploration-report.md');
  }

  get clarificationReport(): string {
    return this.file('clarification-report.md');
  }

  get plan(): string {
    return this.file('plan.md');
  }

  get handoff(): string {
    return this.file('handoff.md');
  }

  chunkJournal(chunk: number): string {
    return this.file(`chunk-${chunk}-journal.md`);
  }

  /** Попытки не перезаписываются: сравнение двух подряд diff'ов — единственный
   *  механический детект отсутствия прогресса. */
  /**
   * Журнал итераций витка. Файл ОБЩИЙ на виток, а не на chunk: вопрос «сколько итераций
   * съел виток» задаётся к витку целиком.
   */
  get iterations(): string {
    return join(this.dir, 'iterations.md');
  }

  /**
   * Черновой самопросмотр попытки — артефакт ПОПЫТКИ, а не журнала chunk'а.
   *
   * Отдельным файлом намеренно: журнал chunk'а — улика этапа 5, и его защищают от
   * переписывания на этапе 6. Самопросмотр же черновой и к вердикту отношения не имеет.
   */
  selfReview(chunk: number, attempt: number): string {
    return join(this.dir, `self-review-${chunk}-attempt-${attempt}.md`);
  }

  chunkDiff(chunk: number, attempt: number): string {
    return this.file(`chunk-${chunk}-attempt-${attempt}-diff.patch`);
  }

  chunkTests(chunk: number, attempt: number): string {
    return this.file(`chunk-${chunk}-attempt-${attempt}-tests.txt`);
  }

  /**
   * Отчёт о шагах попытки в режиме этапа 5 по шагам плана (`stepFill`): что каждый шаг
   * сделал и что сказала проверка после него. Без файла причина красного шага жила только в
   * консоли — разбор прогона восстанавливал её по дереву.
   */
  chunkSteps(chunk: number, attempt: number): string {
    return this.file(`chunk-${chunk}-attempt-${attempt}-steps.md`);
  }

  /**
   * Отчёт приёмки. `route` — номер маршрута ансамбля рецензентов, 0 — основной.
   *
   * Измерение маршрута обязательно: без него все рецензенты ансамбля писали в один файл,
   * вердикт читал его один раз, и в вердикт попадало мнение того, кто дописал последним —
   * слабый рецензент со своим `✅` стирал `❌` сильного. Имя основного маршрута оставлено
   * прежним: его читают скиллы `/sdlc-*` и витки, начатые в терминале.
   */
  verificationReport(chunk: number, attempt: number, route = 0): string {
    const suffix = route === 0 ? '' : `-r${route}`;
    return this.file(`verification-report-${chunk}-attempt-${attempt}${suffix}.md`);
  }

  /**
   * Снимок грязного дерева перед этапом 5: путь → хеш содержимого.
   *
   * Служебный файл рантайма, не артефакт методологии — отсюда точка в имени. Без него
   * scope-гейт вменяет исполнителю чужие незакоммиченные правки оператора; по хешу,
   * а не по имени, потому что правка агента внутри уже-грязного файла обязана остаться
   * видимой.
   */
  chunkBaseline(chunk: number): string {
    return this.file(`.chunk-${chunk}-baseline.json`);
  }

  /**
   * Персистентная лента событий витка (NDJSON, одна `RunEvent`-запись на строку) — тоже
   * служебный файл рантайма, не артефакт методологии. Живёт на весь виток, не на один
   * процесс: `EventBus` (`bus.ts`) держит те же события только в памяти процесса, забывая
   * их при рестарте сервера и при «Убрать» — без этого файла «история витков» умела
   * показать только статус/этап законченного витка, не саму ленту того, что происходило.
   */
  get events(): string {
    return this.file('.events.ndjson');
  }
}
