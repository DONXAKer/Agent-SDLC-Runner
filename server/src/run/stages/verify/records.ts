/**
 * Этап 6: записи рецензента — приём `RecordClaim`/`RecordFinding` со сверкой ссылки с
 * патчем, поклаймовый добор, внесение записей в отчёт и автозаполнение отчёта фактами.
 */

import type { NormalizedCall } from '@sdlc-runner/shared';

import { readArtifact, writeArtifact } from '../../../artifacts/artifact.ts';
import type { ResolvedRoute } from '../../../config/schema.ts';
import { gateKey } from '../../../gates/gatesFile.ts';
import { ProviderEnvError } from '../../../provider/ChatProvider.ts';
import { createProvider } from '../../../provider/registry.ts';
import { claimTextCell } from '../../../verdict/retryBrief.ts';
import { fillClaims } from '../../claimFill.ts';
import type { ClaimAsk } from '../../claimFill.ts';
import { autofillVerificationReport } from '../../verifyAutofill.ts';
import { acceptedClaimStatus, anchorFound, renderRecords, verifyReportGaps } from '../../verifyReport.ts';
import type { SeededArtifact, StageHost } from '../types.ts';
import { REVIEW_GATE, earlyGateRows, earlyGatesForModel } from './gates.ts';

/** Текст, в котором ищется ссылка записи (`VerifyState.anchorHaystack`). */
export function evidenceHaystack(host: StageHost): string {
  const verify = host.verifyState;
  if (verify.anchorHaystack !== null) return verify.anchorHaystack;
  const parts: string[] = [];
  for (const p of [
    host.paths.chunkDiff(host.chunk(), host.attempt()),
    host.paths.chunkTests(host.chunk(), host.attempt()),
    host.paths.plan,
  ]) {
    const a = readArtifact(p);
    if (a.exists) parts.push(a.text);
  }
  verify.anchorHaystack = parts.join('\n');
  return verify.anchorHaystack;
}

/**
 * Пробелы отчёта приёмки этой попытки по пунктам задачи — для стража завершения и для
 * переворота исхода после дозаполнения. Каждый пробел назван с путём отчёта, потому что
 * список уходит в одну строку «артефакт этапа не заполнен: …» вместе с путями.
 */
export function verifyGaps(host: StageHost): string[] {
  const path = host.paths.verificationReport(host.chunk(), host.attempt());
  const report = readArtifact(path);
  if (!report.exists) return [];
  const gaps = verifyReportGaps(report.text, [...host.intentClaimLines().keys()]);
  return gaps.length === 0 ? [] : [`${path} (${gaps.join('; ')})`];
}

/**
 * Принимает запись модели в отчёт приёмки и отвечает ей подтверждением.
 *
 * Ссылка проверяется здесь, а не при рендере: модель обязана узнать об оговорке в тот
 * ход, когда ещё может её исправить. Запись при этом принимается в любом случае —
 * требование ссылки задумано против оформителя, закрывающего бланк вслепую, а не против
 * рецензента, который что-то увидел и не смог показать пальцем.
 */
export function acceptRecord(host: StageHost, call: NormalizedCall): string {
  const verify = host.verifyState;
  if (call.kind === 'record_claim') {
    const anchored = anchorFound(call.evidence, evidenceHaystack(host));
    const had = verify.claimRecords.has(call.id);
    // Зелёный без места в патче принимается как `⚠`, а не как зелёный с пометкой:
    // пометка в колонке доказательства статуса не меняла, и вердикт читал `✅`, которого
    // никто не подтвердил (замер 2026-09-08, класс «оформитель»).
    const status = acceptedClaimStatus(call.status, anchored);
    verify.claimRecords.set(call.id, {
      id: call.id,
      status,
      evidence: anchored ? call.evidence : `${call.evidence} _(ссылка не найдена в патче попытки)_`,
      whatToFix: call.whatToFix,
    });
    return (
      `пункт ${call.id} записан со статусом ${status}${had ? ' (заменил прежнюю запись)' : ''}. ` +
      (anchored
        ? 'Ссылка на место найдена в патче попытки.'
        : (status !== call.status
            ? `Заявленный ${call.status} понижен до ⚠: доказательство не показано. `
            : 'Ссылку на место в патче попытки найти не удалось — пункт помечен: доказательство не показано. ') +
          'Если место есть, назови его точнее (файл:символ, имя теста, хунк) и запиши пункт заново.')
    );
  }

  if (call.kind === 'record_finding') {
    const anchored = anchorFound(call.evidence, evidenceHaystack(host));
    verify.findingRecords.push({
      section: call.section,
      text: call.text,
      evidence: call.evidence,
      anchored,
    });
    return anchored
      ? `находка записана в секцию ${call.section} отчёта.`
      : `находка принята, но БЕЗ привязки к месту: она уйдёт в отчёт отдельной строкой и в ` +
          `вердикт не пойдёт. Назови место (файл:строка, символ, хунк) и запиши заново, если оно есть.`;
  }

  return 'запись не распознана';
}

/**
 * Поклаймовый добор: спросить модель по каждому пункту, о котором она промолчала.
 *
 * Пункты берутся из приёмочного листа ЗАДАЧИ, а не из отчёта: список пунктов — решение
 * человека этапа 1, и выводить его из того, что успела написать модель, значит терять
 * ровно те пункты, до которых она не дошла. Уже записанные не переспрашиваются: добор
 * дополняет работу модели, а не переделывает её.
 */
export async function topUpClaims(host: StageHost, route: ResolvedRoute, system: string): Promise<void> {
  const asks: ClaimAsk[] = [];
  for (const [id, text] of host.intentClaimLines()) {
    if (!host.verifyState.claimRecords.has(id)) asks.push({ id, text });
  }
  if (asks.length === 0) return;

  const limits = host.limits();
  const { calls, envFailure } = await fillClaims({
    provider: createProvider(route.provider, route.providerDef, limits.chatTimeoutMs, host.trace('verify', 'claimFill')),
    model: route.model,
    params: route.params,
    system,
    claims: asks,
    diff: readArtifact(host.paths.chunkDiff(host.chunk(), host.attempt())).text,
    tests: readArtifact(host.paths.chunkTests(host.chunk(), host.attempt())).text,
    // Тот же потолок, что у результата инструмента локального контура: срез патча
    // конкурирует за то же окно, что и всё остальное в вопросе.
    evidenceBudgetBytes: Math.min(limits.maxToolResultBytes, limits.localMaxToolResultBytes),
    signal: host.signal(),
    onProgress: (note) => host.emit({ type: 'warning', runId: host.id, stage: 'verify', message: `поклаймовый добор: ${note}` }),
    onUsage: (usage) => host.accountOffPathUsage('verify', usage, route.providerDef.currency),
  });

  // Ответы проходят тем же приёмом, что и записи модели: проверка ссылки, замена по id,
  // подтверждение. Второго места, знающего форму записи, не появляется.
  for (const call of calls) acceptRecord(host, call);
  if (calls.length > 0) {
    host.emit({
      type: 'warning',
      runId: host.id,
      stage: 'verify',
      message:
        `поклаймовый добор: спрошено ${asks.length} пункт(ов), разобрано ответов — ${calls.length}`,
    });
  }
  // До батчинга (трек 2) упавший запрос пробрасывал исключение из `fillClaims` наружу, и
  // внешний catch этапа (`ProviderEnvError`) отличал отказ СРЕДЫ от отказа модели.
  // `Promise.allSettled` эту метку внутри пачки гасит — здесь она возвращается тем же
  // классом ошибки, уже ПОСЛЕ того как успевшие ответы приняты (не теряя частичный
  // прогресс, которого до батчинга не было вовсе).
  if (envFailure !== null) throw new ProviderEnvError(envFailure);
}

/**
 * Вносит записи модели в отчёт приёмки — после хода, до вердикта.
 *
 * Запись на диск идёт тем же путём, что у спасения артефакта и заполнения по полям:
 * нормализованный `Write` через политику и гейт одобрения. Второго места решения о
 * доступе не появляется.
 */
export async function applyRecords(host: StageHost): Promise<void> {
  const verify = host.verifyState;
  if (verify.claimRecords.size === 0 && verify.findingRecords.length === 0) return;
  const path = host.paths.verificationReport(host.chunk(), host.attempt());
  const report = readArtifact(path);
  if (!report.exists) return;

  const { text, filled } = renderRecords(report.text, {
    claims: [...verify.claimRecords.values()],
    findings: verify.findingRecords,
    // Текст пункта — из листа задачи, тем же разбором, что у брифа ретрая: строка-образец
    // шаблона несёт плейсхолдер, и строка с зелёным статусом при `‹начало пункта…›`
    // выглядела заполненной.
    titles: new Map([...host.intentClaimLines()].map(([id, line]) => [id, claimTextCell(line)] as const)),
  });
  if (filled === 0 || text === report.text) return;

  // Запись — тем же путём, что у спасения артефакта: нормализованный `Write` через
  // политику и гейт одобрения. Оператор видит карточку и вправе её править; отказ
  // означает, что отчёт остаётся таким, каким его оставила модель.
  const call: NormalizedCall = { kind: 'write', path, content: text };
  const decision = await host.requestApproval({
    runId: host.id,
    stage: 'verify',
    requestId: host.syntheticRequestId('records'),
    toolName: 'Write',
    rawInput: { file_path: path, content: text },
    call,
    ctx: host.policyContext('verify'),
  });
  if (!decision.allowed) return;
  const edited = (decision.updatedInput as Record<string, unknown> | null)?.['content'];
  writeArtifact(path, typeof edited === 'string' ? edited : text);
  host.emit({
    type: 'warning',
    runId: host.id,
    stage: 'verify',
    message: `отчёт приёмки дополнен записями рецензента: строк — ${filled}`,
  });
}

/**
 * Заполняет отчёт приёмки фактами рантайма — см. `verifyAutofill.ts`.
 *
 * Результат ревью сюда не передаётся намеренно: на момент автозаполнения рецензент ещё
 * не запускался, и его строка в таблице остаётся модели.
 */
export function autofillVerification(host: StageHost, seeded: SeededArtifact[]): void {
  const verify = host.verifyState;
  // Сброс ДО ранних выходов: без него ансамбль попытки K+1 стартовал бы с бланка
  // попытки K — с её номером в шапке и её таблицей гейтов (ревью-2).
  verify.verifyPrefill = null;
  const path = host.paths.verificationReport(host.chunk(), host.attempt());
  const report = readArtifact(path);
  if (!report.exists || report.placeholders === 0) return;

  const gates = verify.lastGateResults.filter((g) => gateKey(g.name) !== gateKey(REVIEW_GATE));
  const { text, filled } = autofillVerificationReport(report.text, gates, {
    chunk: host.chunk(),
    attempt: host.attempt(),
    slug: host.slug,
    attemptBudget: host.attemptBudget(),
    earlyGates: earlyGateRows(host),
    earlyGatesForModel: earlyGatesForModel(host),
  });
  // Заполненный рантаймом бланк запоминается для ансамбля: дополнительные маршруты
  // стартуют с него, а не с пустого файла — иначе класс расхождений «отчёт/факт» r9,
  // ради которого автозаполнение заведено, возвращался в маршрутах (ревью, К5).
  // Гард выше гарантирует placeholders > 0, поэтому и при filled === 0 бланк живой.
  verify.verifyPrefill = filled > 0 ? text : report.text;
  if (filled === 0) return;

  host.writeAutofilled(path, text, seeded);
  host.emit({
    type: 'warning',
    runId: host.id,
    stage: 'verify',
    message:
      `рантайм заполнил отчёт приёмки фактами прогона (${filled}): таблица «Гейты» и ` +
      'механика шапки — рецензенту остались выводы, ревью и вердикт',
  });
}
