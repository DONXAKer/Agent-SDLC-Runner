/**
 * Этап 6: гейты — прогон набора рантаймом до ревью, статусы «не скриптовых» гейтов по факту,
 * сверка патча с деревом и строки гейтов ранних этапов, чей статус рантайм знает сам.
 */

import type { GateRunResult, GateStatus } from '@sdlc-runner/shared';

import { readArtifact } from '../../../artifacts/artifact.ts';
import { REVIEWER_AGENTS } from '../../../exec/StageExecutor.ts';
import { loadSubagents } from '../../../exec/subagents.ts';
import { gateKey, gatesExpectedInReport } from '../../../gates/gatesFile.ts';
import { isRepo, workingDiff } from '../../../gates/git.ts';
import { runGates } from '../../../gates/run.ts';
import { readBaseline } from '../chunk/evidence.ts';
import { axesGateRow, axisProblems } from '../plan.ts';
import type { StageHost } from '../types.ts';

/** Гейт минимума, который рантайм не исполняет скриптом. */
export const REVIEW_GATE = 'Ревью независимым агентом';

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
      } · ${r.durationMs} мс |\n| | | ${cell(r.lastLine)} |`,
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

  const results = await runGates({
    gates,
    projectRoot: host.projectRoot,
    projectName: host.projectName,
    planFiles: host.planFilesFor('verify') ?? [],
    baseline: readBaseline(host),
    timeoutMs: host.limits().gateTimeoutMs,
    // Описание модулей проекта: человек знает про свой моно-репо больше, чем детект.
    ...(modules === undefined ? {} : { modules }),
    // Вход гейта «Ответы человека в коде»: слаг витка знает только рантайм.
    clarificationPath: host.paths.clarificationReport,
    ...(signal === undefined ? {} : { signal }),
    externalStatuses: externalGateStatuses(host),
    onWarn: (message) => host.emit({ type: 'warning', runId: host.id, stage: 'verify', message }),
    onResult: (gate) => {
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
  verify.lastGateResults = results;
  return results;
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
 * правило «сказано в отчёте». Сравнение — по тому же `workingDiff`, которым патч и
 * снимался, поэтому расхождение означает ровно одно: дерево изменилось ПОСЛЕ снятия
 * улики, и артефакт этапа 5 устарел по-настоящему.
 */
export async function diffStillMatchesTree(host: StageHost): Promise<boolean | null> {
  const patchPath = host.paths.chunkDiff(host.chunk(), host.attempt());
  const saved = readArtifact(patchPath);
  if (!saved.exists) return null;
  try {
    if (!(await isRepo(host.projectRoot))) return null;
    const signal = host.aborterSignal();
    const now = await workingDiff(host.projectRoot, [], ...(signal === undefined ? [] : [signal]));
    return now.trim() === saved.text.trim();
  } catch {
    // Сверка не состоялась — это «не знаю», а не «разошлось»: превращать сбой git в
    // красный вердикт значило бы ронять виток из-за среды.
    return null;
  }
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
