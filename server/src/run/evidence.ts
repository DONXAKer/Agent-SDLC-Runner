/**
 * Свидетельства попытки производит рантайм, а не агент.
 *
 * Замер этапа 5 (`docs/model-runs.md`): исполнитель написал
 * `chunk-1-attempt-1-tests.txt` со строками «PASS ✓ Case 1: Not a repository (5ms)», ни
 * разу не запустив тесты, и `chunk-1-attempt-1-diff.patch`, объявляющий файл удалённым и
 * ссылающийся на несуществующий путь. Оба файла — вход этапа 6. Рецензент, получивший их
 * как данность, судил бы по сочинённому.
 *
 * Дыра здесь не в модели. Пока «улику» пишет тот, чью работу она удостоверяет, вопрос
 * только в том, когда именно её подделают. Поэтому оба файла перезаписываются рантаймом
 * из фактического состояния дерева и фактического прогона — то, что записал агент,
 * свидетельством не считается и в этап 6 не попадает.
 *
 * Рядом с ними — запись `chunk-N-attempt-K-evidence.json` по контракту
 * `attempt-evidence.py` методологии (`SDLC.md` → этап 5): база, HEAD, sha256 патча и
 * вывода тестов, команда, код возврата, улика отсутствующего инструмента, diffstat по
 * файлам, модель исполнителя. Патч и вывод без этой записи — текст исполнителя; сверку
 * хэшей делает этап 6 (`attemptEvidenceFact`) и терминальный `attempt-evidence.py verify`.
 *
 * **В патч не дописывается ничего.** Первая версия ставила в начало служебную шапку с
 * `new Date().toISOString()` — и этим убила безусловный детект топтания: `detectNoProgress`
 * сравнивает патчи двух попыток ДОСЛОВНО, а таймстамп различен всегда. Файл обязан быть
 * побайтово тем, что печатает git: он сверяется и с деревом, и с патчем прошлой попытки.
 * Всё, что рантайм хочет сказать о записи, он говорит событием, а не строкой в улике.
 */

import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';

import { diffstat } from '../diff/diffstat.ts';
import type { Diffstat } from '../diff/diffstat.ts';
import { attemptDiff, git } from '../gates/git.ts';
import type { BuiltinGate, GateContext } from '../gates/builtin/index.ts';
import type { GateStatus } from '@sdlc-runner/shared';

/** Имя и версия записи — тем же полем, что у терминального инструмента: читатель один. */
export const EVIDENCE_TOOL = 'sdlc-runner';
export const EVIDENCE_VERSION = 2;

/**
 * Что стало с деревом за эту попытку.
 *
 * `unknown` — отдельное значение, а не «считаем, что правки были»: если патч посчитать не
 * удалось, исход попытки неизвестен, и прятать это в `changed` значит открывать ровно ту
 * дыру, ради закрытия которой улики и отобраны у агента.
 */
export type TreeChange = 'changed' | 'empty' | 'unknown';

/** Запись `evidence.json` — контракт `attempt-evidence.py` (версия 2) плюс поля рантайма. */
export interface AttemptEvidence {
  tool: string;
  version: number;
  generated_at: string;
  slug: string;
  chunk: number;
  attempt: number;
  base_sha: string | null;
  head_sha: string | null;
  diff_sha256: string;
  diff_empty: boolean;
  diffstat: Diffstat;
  tests_cmd: string | null;
  tests_exit: number | null;
  tests_sha256: string;
  tests_last_line: string;
  missing_tool: string | null;
  executor_model: string;
  executor_model_source: string;
  /** Поля рантайма сверх контракта: статус гейта «Тесты» и признак усечённого вывода. */
  tests_status: GateStatus;
  tests_truncated: boolean;
}

export interface EvidenceResult {
  tree: TreeChange;
  /** Первая строка записи о тестах — для журнала событий. */
  testsNote: string;
  /**
   * Статус того же прогона, структурой, а не подстрокой `testsNote` — для `RunMetrics.
   * chunkEvidence` (см. комментарий там): второй разбор той же строки регуляркой рано или
   * поздно разошёлся бы с текстом, который правится свободно. `⏭` — гейт «Тесты» не найден
   * в наборе, тем же смыслом, что и у `runGates`.
   */
  testsStatus: GateStatus;
  /** Тот же текст, что лёг в `diffPath` — вызывающему он нужен ещё раз (сверка с планом). */
  diff: string;
  /** Записанная запись о свидетельствах. */
  evidence: AttemptEvidence;
}

export function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Пометка усечения, которую ставит захват оболочки (`sandbox/capture.ts`). */
const TRUNCATED_MARK = '…[обрезано рантаймом]…';

/**
 * Перезаписывает патч, запись о тестах и запись о свидетельствах фактами.
 *
 * `diffBefore` — патч рабочего дерева на момент СТАРТА этапа, снятый тем же `attemptDiff`.
 * Без него «дерево не изменилось» считалось бы против базы, а коммита до этапа 7 не
 * бывает: правки прошлой попытки и прошлого chunk'а всё ещё в дереве, и попытка, не
 * сделавшая ничего, выглядела бы результативной.
 *
 * `runTests` передаётся параметром, а не берётся из реестра здесь: этап 5 и этап 6 обязаны
 * гонять один и тот же гейт «Тесты» — тот, что назван в наборе проекта.
 */
export async function recordAttemptEvidence(args: {
  projectRoot: string;
  diffPath: string;
  testsPath: string;
  evidencePath: string;
  diffBefore: string;
  baseSha: string | null;
  gateCtx: GateContext;
  runTests: BuiltinGate | null;
  meta: { slug: string; chunk: number; attempt: number; executorModel: string | null };
  signal?: AbortSignal;
}): Promise<EvidenceResult> {
  const generatedAt = new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00');
  const diff = await attemptDiff(args.projectRoot, {
    baseSha: args.baseSha,
    ...(args.signal === undefined ? {} : { signal: args.signal }),
  });
  // Байты как есть: без перевода `\n` → `\r\n` и без потери `\r` — патч применим `git apply`
  // и сверяется побайтово с перегенерацией.
  writeFileSync(args.diffPath, Buffer.from(diff, 'utf8'));

  const tree: TreeChange = diff.trim() === args.diffBefore.trim() ? 'empty' : 'changed';

  let testsNote: string;
  let testsStatus: GateStatus;
  let testsText: string;
  let testsCmd: string | null = null;
  let testsExit: number | null = null;
  let missing: string | null = null;
  let truncated = false;
  if (args.runTests === null) {
    testsNote = 'гейт «Тесты» в наборе не найден — рантайм тестов не запускал';
    testsStatus = '⏭';
    testsText = `${testsNote}\n`;
  } else {
    const outcome = await args.runTests(args.gateCtx);
    testsStatus = outcome.status;
    testsCmd = outcome.command;
    testsExit = outcome.exitCode;
    missing = outcome.envBlocked === true ? (outcome.missingTool !== undefined ? outcome.missingTool : outcome.lastLine) : null;
    testsNote = `${outcome.status} ${outcome.command ?? 'встроенная реализация'} (код ${outcome.exitCode ?? '—'})`;
    // Полный вывод, а не хвост: методология требует ПОЛНЫЙ вывод команды, усечение —
    // только буфером захвата и с пометкой в записи. Хвост остаётся запасным путём для
    // реализаций, не отдающих полный вывод.
    const body = outcome.output ?? outcome.outputTail ?? '';
    truncated = body.includes(TRUNCATED_MARK) || (outcome.output === undefined && outcome.outputTail !== undefined);
    // Заголовок обязателен: без него файл читается как рассказ исполнителя, а весь смысл
    // правки в том, что читатель видит, КТО его составил. В патче такого заголовка нет —
    // тот сверяется побайтово, а этот файл только читают; его хэш — в `evidence.json`.
    testsText = [
      '# Запись рантайма о фактическом прогоне тестов этой попытки.',
      '# Составлена не исполнителем этапа: содержимое, записанное агентом, перезаписано.',
      '',
      `Команда: ${outcome.command ?? 'встроенная реализация гейта'}`,
      `Статус: ${outcome.status}`,
      `Код возврата: ${outcome.exitCode ?? '—'}`,
      '',
      outcome.lastLine,
      '',
      ...(body.trim() === ''
        ? []
        : [
            truncated
              ? '## Вывод команды (усечён буфером захвата — пометка рантайма)'
              : '## Вывод команды (полный, записан рантаймом)',
            '',
            body,
            '',
          ]),
    ].join('\n');
  }
  writeFileSync(args.testsPath, Buffer.from(testsText, 'utf8'));

  const head = await git(['rev-parse', 'HEAD'], args.projectRoot, args.signal);
  const lastLine = testsText
    .split(/\r?\n/)
    .reverse()
    .find((ln) => ln.trim() !== '');
  const evidence: AttemptEvidence = {
    tool: EVIDENCE_TOOL,
    version: EVIDENCE_VERSION,
    generated_at: generatedAt,
    slug: args.meta.slug,
    chunk: args.meta.chunk,
    attempt: args.meta.attempt,
    base_sha: args.baseSha,
    head_sha: head.code === 0 ? head.stdout.trim() : null,
    diff_sha256: sha256Text(diff),
    diff_empty: diff.trim() === '',
    diffstat: diffstat(diff),
    tests_cmd: testsCmd,
    tests_exit: testsExit,
    tests_sha256: sha256Text(testsText),
    tests_last_line: (lastLine ?? '').slice(0, 200),
    missing_tool: missing,
    executor_model: args.meta.executorModel ?? 'unknown',
    executor_model_source:
      args.meta.executorModel === null ? 'не записана' : 'факт рантайма: маршрут профиля',
    tests_status: testsStatus,
    tests_truncated: truncated,
  };
  writeFileSync(args.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');

  return { tree, testsNote, testsStatus, diff, evidence };
}
