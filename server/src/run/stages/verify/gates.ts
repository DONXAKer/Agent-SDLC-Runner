/**
 * Этап 6: гейты — прогон набора рантаймом до ревью, статусы «не скриптовых» гейтов по факту,
 * сверка патча с деревом и строки гейтов ранних этапов, чей статус рантайм знает сам.
 */

import { existsSync, readFileSync } from 'node:fs';

import type { GateRunResult, GateStatus } from '@sdlc-runner/shared';

import { readArtifact } from '../../../artifacts/artifact.ts';
import { REVIEWER_AGENTS } from '../../../exec/StageExecutor.ts';
import { loadSubagents } from '../../../exec/subagents.ts';
import { gateKey, gatesExpectedInReport } from '../../../gates/gatesFile.ts';
import { attemptDiff, isRepo } from '../../../gates/git.ts';
import { runGates } from '../../../gates/run.ts';
import { sha256Text } from '../../evidence.ts';
import { attemptGateFacts, readBaseline } from '../chunk/evidence.ts';
import { axesGateRow, axisProblems } from '../plan.ts';
import type { StageHost } from '../types.ts';

/** Гейт минимума, который рантайм не исполняет скриптом. */
export const REVIEW_GATE = 'Ревью независимым агентом';

/**
 * «Сверка отчёта с набором» — под раннером её исполняет рантайм: `SKILL.md` sdlc-verify
 * отдаёт Phase 4.3 (`flow-verdict.py`) рантайму, а сверку строк отчёта со включёнными
 * гейтами набора делает расчёт вердикта (`collect.ts`, «гейт не отчитался» роняет
 * вердикт). Строка в отчёте заполняется рантаймом.
 */
export const RECONCILE_GATE = 'Сверка отчёта с набором';

/**
 * Гейты этапа 6 из шаблона набора, у которых нет механики рантайма и которые по
 * `SKILL.md` исполняет проверяющий: их строку заполняет рецензент (инварианты задачи — §4
 * его ответа). Прежде включённая строка без команды блокировала старт витка «исполнить
 * нечем» — включить гейт по шаблону эталона было нельзя (code-review-all 2026-09-23).
 * «Сверка тестов с claims» отсюда ушла: у неё есть встроенная реализация
 * (`builtin/testsClaims.ts`, порт эталона), и строку заполняет факт прогона.
 */
export const MODEL_REPORTED_GATES: readonly string[] = ['Проектные инварианты как ассерты'];

/**
 * Гейты этапа 6 без скрипта и кто за них отчитывается: `model` — рецензент (ревью и гейты
 * проверяющего), `runtime` — рантайм (сверка отчёта с набором). ОДНА таблица на старт витка
 * (`UNSCRIPTED_GATES`), прогон гейтов и автозаполнение отчёта (`reportedBy`): три копии
 * списка уже расходились (code-review-all 2026-09-23).
 */
const REPORTED = new Map<string, 'model' | 'runtime'>([
  [gateKey(REVIEW_GATE), 'model'],
  [gateKey(RECONCILE_GATE), 'runtime'],
  ...MODEL_REPORTED_GATES.map((n): [string, 'model'] => [gateKey(n), 'model']),
]);

/** Гейты этапа 6 без скрипта: исключение для старта витка (`Run.blockers`, `unimplementedGates`). */
export const UNSCRIPTED_GATES: readonly string[] = [REVIEW_GATE, RECONCILE_GATE, ...MODEL_REPORTED_GATES];

/**
 * Кто отчитывается за строку набора, если не скрипт; `null` — строку исполняет команда или
 * встроенная реализация. Команда в обратных кавычках побеждает имя — «где стоит команда —
 * выполняется она», иначе проектная команда гейта инвариантов не исполнялась. Кроме
 * ревью: его статус — всегда факт прогона рецензента (`externalGateStatuses`), команду
 * строки рантайм не исполняет, и строку заполняет модель.
 */
export function reportedBy(row: { name: string; command: string | null }): 'model' | 'runtime' | null {
  const key = gateKey(row.name);
  if (key === gateKey(REVIEW_GATE)) return 'model';
  return row.command !== null ? null : (REPORTED.get(key) ?? null);
}

/**
 * Итоги прогона гейтов для входа рецензента.
 *
 * Дословный вывод команды не подклеиваем: сборка печатает мегабайты, а рецензенту нужен
 * статус и последняя содержательная строка. Полный вывод остаётся в шине событий.
 */
export function gateReportBlock(results: readonly GateRunResult[]): string {
  // Вертикальная черта экранируется, как требует форма набора. Без этого команда или
  // строка ошибки с трубой (`grep 'a|b'`, вывод junit) разъезжает по колонкам, а
  // разъехавшуюся таблицу рецензент переносит в отчёт — там сдвинутая колонка «Статус»
  // читается как `⏭` и роняет вердикт по несуществующей причине.
  const cell = (v: string): string => v.split('\n').join(' ').split('|').join('\\|');

  const rows = results.map(
    (r) =>
      `| ${cell(r.name)} | ${r.status} | ${cell(r.command ?? 'встроенная проверка')} · код ${
        r.exitCode ?? '—'
      } · ${r.durationMs} мс |\n| | | ${cell(r.lastLine)} |` +
      // Улики гейт-скрипта по контракту — то, что рецензент цитирует в отчёте; без них
      // «❌ Scope» оставалось голым словом, и рецензент шёл искать пути сам.
      (r.evidence ?? [])
        .slice(0, 8)
        .map((e) => `\n| | | улика: ${cell(e)} |`)
        .join(''),
  );
  return [
    '## Итоги автоматических гейтов (прогон рантайма, этот этап)',
    '',
    'Эти статусы получены фактическим прогоном до начала ревью. Переписывать их своим',
    'мнением нельзя: в отчёт они переносятся как есть, а вердикт считается по худшему из',
    'двух — твоего и фактического. Твоя работа — §1–§5 отчёта и поиск того, чего гейты',
    'не видят.',
    '',
    '| Гейт | Статус | Результат |',
    '|---|---|---|',
    ...rows,
  ].join('\n');
}

/**
 * Прогон автоматических гейтов этапа 6.
 *
 * Порядок из методологии: автоматические гейты идут ПЕРЕД ревью, а не держатся на
 * промпте рецензента — поэтому это шаг рантайма, который модель не может пропустить.
 * Результаты уходят в шину по одному, чтобы длинная сборка была видна по ходу, а не
 * появлялась разом в конце.
 */
export async function runVerifyGates(host: StageHost, signal?: AbortSignal): Promise<GateRunResult[]> {
  const gates = host.gatesFile();
  if (gates === null) return [];
  const verify = host.verifyState;
  const modules = host.projectModules();

  // Итоги копятся по одному, а не присваиваются разом в конце: интерфейс перечитывает
  // состояние по событию `gate_result`, и при позднем присваивании каждый такой запрос
  // возвращал таблицу ПРЕДЫДУЩЕГО прогона — зелёную, пока текущий уже краснел.
  verify.lastGateResults = [];
  verify.lastGatesAborted = false;

  const facts = await attemptGateFacts(host, gates);
  const results = await runGates({
    ...facts,
    // Гейты без исполнителя-скрипта (строки проверяющего и сверка набора) рантаймом не
    // «прогоняются»: прогон давал им `⏭ исполнить нечем`, этот факт шёл в вердикт худшим
    // из двух и ронял каждую попытку, а строка отчёта для модели не появлялась вовсе —
    // автозаполнение считало её уже заполненной фактом (code-review-all 2026-09-23).
    // Статус таких строк — в отчёте: у сверки его пишет рантайм, у остальных — рецензент.
    // Ревью остаётся в прогоне: его статус подставляет `externalStatuses` ниже.
    gates: { ...gates, rows: gates.rows.filter((r) => reportedBy(r) === null || gateKey(r.name) === gateKey(REVIEW_GATE)) },
    projectRoot: host.projectRoot,
    projectName: host.projectName,
    planFiles: host.planFilesFor('verify') ?? [],
    baseline: readBaseline(host),
    timeoutMs: host.limits().gateTimeoutMs,
    // Описание модулей проекта: человек знает про свой моно-репо больше, чем детект.
    ...(modules === undefined ? {} : { modules }),
    // Вход гейта «Ответы человека в коде»: слаг витка знает только рантайм.
    clarificationPath: host.paths.clarificationReport,
    // Вход резерва mutationCheckGate — та же причина, что у clarificationPath выше.
    slug: host.slug,
    ...(signal === undefined ? {} : { signal }),
    externalStatuses: externalGateStatuses(host),
    onWarn: (message) => host.emit({ type: 'warning', runId: host.id, stage: 'verify', message }),
    onResult: (raw) => {
      // Полный вывод команды (до сотен КБ) — только улике этапа 5 (`recordEvidence`), не
      // ленте событий и не состоянию попытки: иначе каждый гейт с командой раздувал бы
      // `.events.ndjson` и SSE (ревью).
      const gate = withoutOutput(raw);
      verify.lastGateResults.push(gate);
      // В метрики результат идёт не отсюда: гейты прогоняются ДО вызова рецензента,
      // поэтому «Ревью независимым агентом» здесь всегда `⏭`, и каждый зелёный виток
      // копил «гейт включён, но проверка не состоялась» (ревью). Учёт — по итоговым
      // статусам, там же, где считается вердикт.
      host.emit({ type: 'gate_result', runId: host.id, stage: 'verify', gate });
    },
  });

  // Отмена прерывает цикл гейтов и возвращает то, что успело прогнаться. Без этой
  // отметки частичный набор выглядел в интерфейсе полным: две зелёные строки читались
  // как «весь набор пройден», хотя обязательная пятёрка не запускалась.
  verify.lastGatesAborted = signal?.aborted === true;
  verify.lastGateResults = results.map(withoutOutput);
  return verify.lastGateResults;
}

function withoutOutput(r: GateRunResult): GateRunResult {
  if (r.output === undefined) return r;
  const { output: _dropped, ...lean } = r;
  return lean;
}

/**
 * Статусы гейтов, которые рантайм не исполняет скриптом.
 *
 * «Ревью независимым агентом» — единственный такой в минимальной пятёрке, и зелёный он
 * получает ТОЛЬКО по факту состоявшегося прогона субагента-рецензента на этой попытке.
 *
 * Раньше статус выводился из наличия файла `sdlc-reviewer.md` на диске и вычислялся до
 * запуска исполнителя. Пока флоу `loop` не умел субагентов, это давало ложный зелёный
 * на каждом витке профиля `local`: определение лежит в каталоге, ревью не было — а гейт,
 * ради которого построен принцип «автор не рецензирует себя», отчитывался `✅`. Теперь
 * оба флоу запускают рецензента по-настоящему (loop — вложенным циклом), но правило
 * не изменилось: зелёный ставит только факт прогона, не файл на диске.
 */
export function externalGateStatuses(host: StageHost): Record<string, GateStatus> {
  const { missing } = loadSubagents(host.runner().agentsDir, REVIEWER_AGENTS);

  const status: GateStatus =
    missing.length === REVIEWER_AGENTS.length
      ? '⏭' // ни одного определения субагента нет — рецензировать некому
      : host.verifyState.reviewerRan
        ? '✅'
        : '⏭'; // прогона ещё не было либо субагент не вызывался

  return { [gateKey(REVIEW_GATE)]: status };
}

/**
 * Совпадает ли патч попытки с фактическим деревом — ФАКТ рантайма, не слова отчёта.
 *
 * `null` — проверить нечем (патча нет, дерево не репозиторий): тогда действует прежнее
 * правило «сказано в отчёте». Сравнение — по тому же `attemptDiff` от той же базы, которым
 * патч и снимался, поэтому расхождение означает ровно одно: дерево изменилось ПОСЛЕ снятия
 * улики, и артефакт этапа 5 устарел по-настоящему. База — из `evidence.json` попытки
 * (та, от которой патч снят фактически), без записи — текущая база витка.
 */
export async function diffStillMatchesTree(host: StageHost): Promise<boolean | null> {
  const patchPath = host.paths.chunkDiff(host.chunk(), host.attempt());
  if (!existsSync(patchPath)) return null;
  try {
    if (!(await isRepo(host.projectRoot))) return null;
    const signal = host.aborterSignal();
    const rec = readEvidence(host);
    const baseSha = rec !== null && typeof rec.base_sha === 'string' ? rec.base_sha : (await host.baseSha()).sha;
    const now = await attemptDiff(host.projectRoot, { baseSha, ...(signal === undefined ? {} : { signal }) });
    // Побайтово, как терминальный `attempt-evidence.py verify`: патч записан байтами git.
    return sha256Text(now) === sha256Text(readFileSync(patchPath, 'utf8'));
  } catch {
    // Сверка не состоялась — это «не знаю», а не «разошлось»: превращать сбой git в
    // красный вердикт значило бы ронять виток из-за среды.
    return null;
  }
}

function readEvidence(host: StageHost): Record<string, unknown> | null {
  const path = host.paths.chunkEvidence(host.chunk(), host.attempt());
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Свидетельства попытки произведены инструментом и сошлись с файлами — ФАКТ рантайма.
 *
 * `null` — запись на месте, хэши патча и вывода тестов совпали. Строка — причина, по
 * которой патч и вывод свидетельством не считаются (`SDLC.md` → этап 5): записи нет,
 * она не читается, либо файлы правлены после её снятия. `undefined` не бывает: у этапа 6
 * патч — обязательное предусловие, и отсутствие записи рядом с ним — уже находка.
 */
export function attemptEvidenceFact(host: StageHost): string | null {
  const chunk = host.chunk();
  const attempt = host.attempt();
  const path = host.paths.chunkEvidence(chunk, attempt);
  if (!existsSync(path)) {
    return `записи ${path} нет — патч и вывод тестов написаны не инструментом, свидетельством не считаются`;
  }
  const rec = readEvidence(host);
  if (rec === null) return `запись ${path} не читается как JSON`;
  const problems: string[] = [];
  const patchPath = host.paths.chunkDiff(chunk, attempt);
  const testsPath = host.paths.chunkTests(chunk, attempt);
  if (!existsSync(patchPath)) problems.push('патча попытки нет');
  else if (rec.diff_sha256 !== sha256Text(readFileSync(patchPath, 'utf8'))) {
    problems.push('хэш патча не сошёлся с записью — патч правлен после снятия свидетельств');
  }
  if (!existsSync(testsPath)) problems.push('записи о тестах нет');
  else if (rec.tests_sha256 !== sha256Text(readFileSync(testsPath, 'utf8'))) {
    problems.push('хэш вывода тестов не сошёлся с записью — файл правлен после снятия свидетельств');
  }
  if (typeof rec.tool !== 'string' || rec.tool === '') problems.push('в записи не назван инструмент');
  return problems.length === 0 ? null : problems.join('; ');
}

/** Итоги прогона с пересчитанными статусами «не скриптовых» гейтов. */
export function gateResultsForVerdict(host: StageHost): GateRunResult[] {
  const external = externalGateStatuses(host);
  return host.verifyState.lastGateResults.map((r) => {
    const fresh = external[gateKey(r.name)];
    if (fresh === undefined || fresh === r.status) return r;
    return {
      ...r,
      status: fresh,
      lastLine:
        fresh === '✅'
          ? 'независимый рецензент отработал на этой попытке'
          : 'независимый рецензент на этой попытке не запускался',
    };
  });
}

/**
 * Строки гейтов РАННИХ этапов, статус которых рантайм знает своими глазами.
 *
 * Сегодня такой один — «Разбор последствий» (этап 4): его исход это результат
 * `axisProblems()`, посчитанный по плану той же программой. Всё остальное из ранних
 * этапов по-прежнему переносит модель: у рантайма нет своего измерения для «Готовности
 * задачи» или «Заполненности артефактов», и выдумывать его здесь значило бы ровно то,
 * против чего заведено автозаполнение.
 */
export function earlyGateRows(host: StageHost): { name: string; stage: string; status: string; seenIn: string }[] {
  const row = axesGateRow(host.gatesFile());
  if (row === null) return [];
  const problems = axisProblems(host);
  return [
    {
      name: row.name,
      stage: '4',
      // `❌`, а не `⏭`: рантайм знает не «не запускалось», а «проверено и провалено», и
      // разница у этих глифов не косметическая — `⏭` снимается подписанной строкой
      // неприменимости (`verdict.ts`), то есть измеренный провал разбора можно было
      // закрыть подписью, а `❌` так не снимается (ревью).
      status: problems.length === 0 ? '✅' : '❌',
      seenIn:
        problems.length === 0
          ? 'plan.md, секция «Последствия шагов»'
          : `plan.md — разбор не доведён: ${problems[0] ?? ''}`,
    },
  ];
}

/**
 * Включённые гейты ранних этапов, статуса которых у рантайма нет: их переносит модель,
 * и строка-образец в отчёте нужна ровно ради них.
 */
export function earlyGatesForModel(host: StageHost): string[] {
  const gates = host.gatesFile();
  if (gates === null) return [];
  const mine = new Set(earlyGateRows(host).map((g) => gateKey(g.name)));
  return gatesExpectedInReport(gates)
    .filter((r) => r.reportsAt !== 'этап 6' && !mine.has(gateKey(r.name)))
    .map((r) => r.name);
}
