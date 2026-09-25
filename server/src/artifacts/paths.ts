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

import type { ArtifactKey } from '@sdlc-runner/shared';
// Реэкспорт: до этой правки `ArtifactKey`/`isArtifactKey` жили только здесь, и часть
// кодовой базы импортирует их отсюда — молчаливая ломка импортов дороже одной строки.
export { isArtifactKey } from '@sdlc-runner/shared';
export type { ArtifactKey } from '@sdlc-runner/shared';

export const SDLC_DIR = '.sdlc';

/**
 * Базовое имя файла — канонический артефакт витка (`WitokPaths`, без служебных дот-файлов).
 * Нужно там, где путь известен, а витка — нет (стенд классифицирует отказ по имени, а не
 * по тому, чей это каталог): запись `clarification-report.md` мимо `.sdlc/<slug>/` —
 * ошибка адресации своего артефакта, а не попытка выйти за границы.
 */
export function isWitokArtifactName(name: string): boolean {
  const n = name.trim().toLowerCase();
  if (['intent.md', 'readiness.md', 'exploration-report.md', 'clarification-report.md', 'plan.md', 'handoff.md'].includes(n)) {
    return true;
  }
  return (
    /^chunk-\d+-journal\.md$/.test(n) ||
    /^plan-v\d+\.md$/.test(n) ||
    /^self-review-\d+-attempt-\d+\.md$/.test(n) ||
    /^verification-report-\d+-attempt-\d+\.md$/.test(n) ||
    /^chunk-\d+-attempt-\d+-(diff\.patch|tests\.txt|evidence\.json|review\.md)$/.test(n)
  );
}

/** Подкаталог служебных файлов раннера внутри каталога витка (`.sdlc/<slug>/.runner/`). */
export const RUNNER_DIR = '.runner';

/**
 * Служебный файл рантайма в каталоге витка (по базовому имени): дот-файлы (лента событий,
 * снимки baseline) и числа витка. Одно определение на политику (запись
 * моделью закрыта) и на коммит handoff (в репозиторий проекта не уходят).
 */
export function isRuntimeServiceName(name: string): boolean {
  return name.startsWith('.') || /^metrics\.(json|md)$/i.test(name);
}

/**
 * Служебный ли путь ВНУТРИ каталога витка (`rest` — относительно `.sdlc/<slug>/`): дот-файл
 * в корне каталога либо что угодно под `.runner/`. Служебные файлы раннера (самопросмотры,
 * отчёты о шагах, журнал итераций, числа витка, отчёты маршрутов ансамбля) живут в
 * `.runner/`: методология считает содержимое `.sdlc/<slug>/` своими артефактами, и
 * `flow-verdict.py` сканирует их на плейсхолдеры — файлы раннера под этот скан не попадают.
 */
export function isRuntimeServicePath(rest: string): boolean {
  // Без учёта регистра: на NTFS `.Runner/metrics.json` — тот же файл, что `.runner/…`.
  const norm = rest.replace(/\\/g, '/').toLowerCase();
  if (norm.startsWith(`${RUNNER_DIR}/`) || norm === RUNNER_DIR) return true;
  // Снимок секций задачи (`.intent-sections.json`) — артефакт методологии, а не этой машины:
  // его пишет и `intent-sections.py`, и он обязан пережить клон (виток продолжается в
  // терминале). Остальные дот-файлы — состояние рантайма.
  if (norm === '.intent-sections.json') return false;
  return !norm.includes('/') && isRuntimeServiceName(norm);
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

  /**
   * Архив прежней редакции плана (`SDLC.md` → «Раскладка артефактов»): действующий план —
   * всегда `plan.md`, прежняя редакция перед перезаписью переименовывается в `plan-v‹K›.md`
   * как есть — с подписью человека под той редакцией, которую он одобрял.
   */
  planArchive(k: number): string {
    return this.file(`plan-v${k}.md`);
  }

  /** Каталог служебных файлов раннера внутри витка (`RUNNER_DIR`). */
  get runnerDir(): string {
    return join(this.dir, RUNNER_DIR);
  }

  private runnerFile(name: string): string {
    return join(this.runnerDir, name);
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
    return this.runnerFile('iterations.md');
  }

  /** Прежнее место журнала итераций (до `.runner/`): читается для витков, начатых раньше. */
  get iterationsLegacy(): string {
    return join(this.dir, 'iterations.md');
  }

  /**
   * Черновой самопросмотр попытки — артефакт ПОПЫТКИ, а не журнала chunk'а.
   *
   * Отдельным файлом намеренно: журнал chunk'а — улика этапа 5, и его защищают от
   * переписывания на этапе 6. Самопросмотр же черновой и к вердикту отношения не имеет.
   */
  selfReview(chunk: number, attempt: number): string {
    // В корне витка, не в `.runner/`: самопросмотр пишет МОДЕЛЬ, а `.runner/` закрыт ей на
    // запись политикой — иначе каждая попытка получала бы гарантированный отказ (ревью).
    return join(this.dir, `self-review-${chunk}-attempt-${attempt}.md`);
  }

  /**
   * Сырой ответ рецензента как есть — артефакт попытки методологии (`sdlc-verify/SKILL.md`:
   * «`chunk-N-attempt-K-review.md` (ответ рецензента как есть)»); `flow-verdict.py` его на
   * плейсхолдеры не судит (рецензент вправе цитировать «‹причина›»).
   */
  chunkReviewText(chunk: number, attempt: number): string {
    return this.file(`chunk-${chunk}-attempt-${attempt}-review.md`);
  }

  chunkDiff(chunk: number, attempt: number): string {
    return this.file(`chunk-${chunk}-attempt-${attempt}-diff.patch`);
  }

  chunkTests(chunk: number, attempt: number): string {
    return this.file(`chunk-${chunk}-attempt-${attempt}-tests.txt`);
  }

  /**
   * Запись о свидетельствах попытки (`SDLC.md` → этап 5): база, хэши патча и вывода тестов,
   * команда, код возврата, улика отсутствующего инструмента, diffstat, модель исполнителя.
   * Тот же контракт, что у `attempt-evidence.py` методологии: патч и вывод без этой записи
   * — текст исполнителя, свидетельством не считаются.
   */
  /**
   * Ответ рецензента по контракту `verify-review-v1` (`implementations/runner-contract`
   * методологии) — служебный файл попытки: дот-файл, модели не пишется, в коммит не идёт;
   * `state_contract.py validate-review` читает его как есть.
   */
  chunkReview(chunk: number, attempt: number): string {
    return this.file(`.chunk-${chunk}-attempt-${attempt}-review.json`);
  }

  chunkEvidence(chunk: number, attempt: number): string {
    return this.file(`chunk-${chunk}-attempt-${attempt}-evidence.json`);
  }

  /**
   * Отчёт о шагах попытки в режиме этапа 5 по шагам плана (`stepFill`): что каждый шаг
   * сделал и что сказала проверка после него. Без файла причина красного шага жила только в
   * консоли — разбор прогона восстанавливал её по дереву.
   */
  chunkSteps(chunk: number, attempt: number): string {
    return this.runnerFile(`chunk-${chunk}-attempt-${attempt}-steps.md`);
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
    // Отчёты дополнительных маршрутов ансамбля — служебные файлы раннера: методология
    // знает один отчёт попытки, и `flow-verdict.py` их не читает.
    if (route !== 0) return this.runnerFile(`verification-report-${chunk}-attempt-${attempt}-r${route}.md`);
    return this.file(`verification-report-${chunk}-attempt-${attempt}.md`);
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
   * Снимок секций `intent.md` (`artifacts/intentSections.ts`): хэши секций, строки листа,
   * счётчик одобрений. Служебный файл рантайма (дот-файл) — тем же именем, что у
   * `intent-sections.py` методологии, чтобы виток продолжался в терминале.
   */
  get intentSections(): string {
    return this.file('.intent-sections.json');
  }

  /**
   * Числа витка, полный снапшот (JSON) — служебный файл рантайма, не артефакт методологии.
   *
   * Единственный читатель — сам рантайм: `Run` восстанавливает накопители метрик из этого
   * файла при пересоздании витка (рестарт сервиса), как chunk/attempt восстанавливаются из
   * журналов. Под формы (`ArtifactKey`) файл не подходит и не подпадает.
   */
  get metrics(): string {
    return this.runnerFile('metrics.json');
  }

  /**
   * Тот же снапшот человекочитаемой разметкой — для разбора витка без интерфейса, прямо
   * из каталога `.sdlc/<slug>/`. Рендерится из того же `metrics.json`, второго источника
   * чисел нет. Служебный файл, не артефакт методологии.
   */
  get metricsReport(): string {
    return this.runnerFile('metrics.md');
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

  /** Прежнее место чисел витка (до `.runner/`): читается для витков, начатых раньше. */
  get metricsLegacy(): string {
    return this.file('metrics.json');
  }
}
