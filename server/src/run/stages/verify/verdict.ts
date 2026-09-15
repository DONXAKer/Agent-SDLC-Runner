/**
 * Этап 6: вердикт — по отчётам всех маршрутов ансамбля и фактическому прогону гейтов, с
 * заметками к нему; и выжимка для ретрая из записей рецензента. Учёт статистики попытки
 * (итерации, счётчики красного, агрегаты гейтов) остаётся витку — это метрики `Run`.
 */

import type { Verdict, VerdictInput } from '@sdlc-runner/shared';

import { readArtifact } from '../../../artifacts/artifact.ts';
import { gateKey, uncalibratedGates } from '../../../gates/gatesFile.ts';
import { classifyRedVerdict } from '../../../verdict/classify.ts';
import { collectVerdictInput, manualClaimIds } from '../../../verdict/collect.ts';
import { claimTextCell, type RetryDetail } from '../../../verdict/retryBrief.ts';
import { computeVerdict } from '../../../verdict/verdict.ts';
import type { StageHost } from '../types.ts';
import { REVIEW_GATE, gateResultsForVerdict } from './gates.ts';

/**
 * Тексты для выжимки ретрая — всё уже посчитано этапом 6, здесь только сбор:
 * пункты приёмки дословно из задачи (во входах chunk'а `intent.md` нет), «что чинить»
 * из записей рецензента, находки §2–§5 с местом. До этого бриф нёс id и числа.
 */
export function retryDetail(host: StageHost): RetryDetail {
  const claimTexts = new Map([...host.intentClaimLines()].map(([id, line]) => [id, claimTextCell(line)] as const));
  const whatToFix = new Map<string, string>();
  for (const [id, r] of host.verifyState.claimRecords) {
    if (r.whatToFix !== null && r.whatToFix.trim() !== '') whatToFix.set(id.toLowerCase(), r.whatToFix);
  }
  return {
    claimTexts,
    whatToFix,
    findings: host.verifyState.findingRecords.map((f) => ({ text: f.text, evidence: f.evidence, anchored: f.anchored })),
  };
}

/**
 * Вердикт этапа 6 по отчёту приёмки и фактическому прогону гейтов — с заметками, входом и
 * классом красного в состоянии попытки. `null` — набора гейтов нет, считать не по чему.
 *
 * Считается кодом, а не моделью: слабый рецензент может ошибиться в статусе, но
 * ложный зелёный выдать не может.
 */
export function stageVerdict(host: StageHost, noProgress: boolean): { verdict: Verdict; input: VerdictInput } | null {
  const gates = host.gatesFile();
  if (gates === null) return null;
  const verify = host.verifyState;
  const progressClosenessWarn = host.limits().progressClosenessWarn;

  // Отчёты ВСЕХ маршрутов ансамбля, а не один канонический: свод по худшему статусу
  // делает «`✅` только если так сказали все» свойством вердикта. Раньше все рецензенты
  // писали в один файл, и в вердикт попадало мнение записавшего последним.
  const routeCount = Math.max(1, host.ensembleRoutes().length);
  const reports = Array.from({ length: routeCount }, (_, r) =>
    readArtifact(host.paths.verificationReport(host.chunk(), host.attempt(), r)).text,
  ).filter((t) => t.trim() !== '');

  const { input, disagreements, reportQuality } = collectVerdictInput({
    gates,
    // Статусы гейтов, которые рантайм не исполняет скриптом, пересчитываются здесь:
    // прогон идёт ДО ревью, и на его момент рецензент заведомо не отработал. Без
    // пересчёта гейт ревью навсегда оставался бы `⏭` даже после честного прогона.
    gateResults: gateResultsForVerdict(host),
    // Факт запуска рецензента рантайм знает достовернее отчёта: `⏭` («не запускался»)
    // в отчёте не может опровергнуть состоявшийся вызов субагента. Красный отчёта при
    // этом всё равно побеждает — см. `collectVerdictInput`.
    runtimeAuthoritativeWhenGreen: [gateKey(REVIEW_GATE)],
    // Совпадение патча попытки с фактическим деревом рантайм проверяет САМ — сверкой
    // побайтово, а не чтением прозы «Сверка с деревом: да» из отчёта. Живая серия r31:
    // три сэмпла подряд с безупречным кодом (9/9) получили красный вердикт «артефакт
    // этапа 5 устарел» только потому, что слабый рецензент не написал нужного слова.
    // Критическое условие вердикта не может висеть на формулировке модели, когда
    // рантайм в состоянии посчитать его механически.
    diffMatchesTreeFact: verify.diffFactMatchesTree,
    // Ручные пункты приходят из ЗАДАЧИ, а не из отчёта: освобождение от автоматической
    // проверки — решение человека, написавшего приёмочный лист.
    manualClaims: manualClaimIds(readArtifact(host.paths.intent).text),
    // Список пунктов — тоже из ЗАДАЧИ: пункт, о котором отчёт молчит, вердикт прежде не
    // видел вовсе и считал отчёт по тем строкам, которые модель соизволила написать.
    expectedClaims: [...host.intentClaimLines().keys()],
    reports,
    // Попытки, сгоревшие на среде, из счёта вычитаются: бюджет итераций тратится на
    // работу, а не на машину. Номер попытки при этом растёт всегда — см. nextAttempt.
    attempt: Math.max(1, host.attempt() - host.envBlockedAttempts()),
    attemptBudget: host.attemptBudget(),
    noProgress,
  });

  const verdict = computeVerdict(input, disagreements);
  // Расхождение отчёта с прогоном не роняет вердикт само по себе (в статус уже взят
  // худший из двух), но обязано быть видно: рецензент, переписывающий статусы, —
  // отдельный симптом, о котором оператор должен узнать.
  // Близость называется фактом рядом с причинами — и ТОЛЬКО у красного: у зелёного
  // вопроса «топчемся ли» нет. `passed` при этом не пересчитывается по длине `reasons`,
  // иначе приписка сама делала бы вердикт красным.
  const closenessNote =
    !verdict.passed &&
    verify.closeness !== null &&
    verify.closeness >= progressClosenessWarn
      ? [
          `патч этой попытки совпадает с предыдущей на ${Math.round(verify.closeness * 100)}% ` +
            `по существу (порог ${Math.round(
              progressClosenessWarn * 100,
            )}%) — похоже на топтание на месте; решение о переходе принимает человек`,
        ]
      : [];

  // Пометка о некалиброванных гейтах: красный, полученный проверкой, чью способность
  // ловить никто не подтверждал посевом, стоит читать с оговоркой. На `passed` это не
  // влияет — иначе один флаг в наборе гейтов начал бы решать судьбу витка.
  // Показывается при ЛЮБОМ исходе, а не только при красном: текст говорит «„зелёный“ от
  // них слабее, чем выглядит», то есть адресован ровно тому случаю, когда вердикт
  // зелёный и человек собирается принимать работу. Условие `!passed` выключало
  // предупреждение в единственной ситуации, ради которой оно написано.
  // Ветка `gates === null` тут мёртвая — до неё функция уже вышла.
  const uncalibrated = uncalibratedGates(gates);
  const calibrationNote =
    uncalibrated.length > 0
      ? [
          `посевом не проверялись гейты: ${uncalibrated.join(', ')} — их способность ` +
            'ловить дефекты не подтверждена, и «зелёный» от них слабее, чем выглядит',
        ]
      : [];

  // Замечания к качеству отчёта идут в заметки вердикта, но НЕ в причины красного:
  // рантайм исполнил гейт сам и получил зелёный, а рецензент вписал красный (r23).
  const notes = [...disagreements, ...reportQuality, ...closenessNote, ...calibrationNote];
  const withNotes: Verdict =
    notes.length === 0 ? verdict : { ...verdict, reasons: [...verdict.reasons, ...notes] };

  verify.verdict = withNotes;
  verify.lastVerdictInput = input;
  // Классификация считается только по красному: у зелёного «куда возвращать» нет вопроса.
  verify.redCause = withNotes.passed ? null : classifyRedVerdict(input, disagreements);
  return { verdict: withNotes, input };
}
