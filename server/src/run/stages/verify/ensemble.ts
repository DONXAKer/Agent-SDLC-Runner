/**
 * Этап 6: дополнительные маршруты ансамбля рецензентов — полный второй проход либо узкие
 * вопросы по пунктам, в которых основной маршрут не уверен.
 */

import { localResultBytes } from '../../../config/limits.ts';
import type { PreparedPrompt } from '@sdlc-runner/shared';

import { readArtifact, writeArtifact } from '../../../artifacts/artifact.ts';
import { claimIdOf } from '../../../artifacts/claims.ts';
import type { ResolvedRoute } from '../../../config/schema.ts';
import type { ExecHooks, SubagentDef } from '../../../exec/StageExecutor.ts';
import { ProviderEnvError } from '../../../provider/ChatProvider.ts';
import { createProvider } from '../../../provider/registry.ts';
import { readReport } from '../../../verdict/collect.ts';
import { claimTextCell } from '../../../verdict/retryBrief.ts';
import { fillClaims } from '../../claimFill.ts';
import type { ClaimAsk } from '../../claimFill.ts';
import { anchorFound, renderRecords } from '../../verifyReport.ts';
import type { ClaimRecord } from '../../verifyReport.ts';
import type { StageDef, StageHost } from '../types.ts';
import { evidenceHaystack } from './records.ts';

/**
 * Пункты, в которых основной маршрут не уверен: `⚠` — «доказательство держится на
 * непройденной проверке». Именно они и стоят второго мнения; зелёные и красные пункты
 * второй раз не оплачиваются.
 */
export function uncertainClaims(host: StageHost, report: string): ClaimAsk[] {
  const intent = readArtifact(host.paths.intent);
  if (!intent.exists) return [];
  const unsure = new Set(
    readReport(report)
      .claims.filter((c) => c.status === '⚠')
      .map((c) => c.id),
  );
  if (unsure.size === 0) return [];

  const out: ClaimAsk[] = [];
  for (const line of intent.text.split(/\r?\n/)) {
    const id = claimIdOf(line);
    if (id === null || !unsure.has(id.toLowerCase())) continue;
    out.push({ id: id.toLowerCase(), text: line.trim() });
  }
  return out;
}

/**
 * Узкий маршрут ансамбля: вопросы по названным пунктам вместо полного ревью.
 *
 * Отчёт маршрута собирается из бланка рантайма теми же `renderRecords`, что и отчёт
 * основного маршрута: вторая форма отчёта в кодовой базе означала бы вторую форму
 * разбора и, рано или поздно, расхождение вердикта с самим собой.
 */
export async function narrowRoute(
  host: StageHost,
  route: ResolvedRoute,
  prompt: PreparedPrompt,
  canonical: string,
  claims: readonly ClaimAsk[],
): Promise<void> {
  const limits = host.limits();
  const { calls, envFailure } = await fillClaims({
    provider: createProvider(route.provider, route.providerDef, limits.chatTimeoutMs, host.trace('verify', 'claimFill')),
    model: route.model,
    params: route.params,
    constrainedChoice: route.constrainedChoice,
    system: prompt.system,
    claims,
    diff: readArtifact(host.paths.chunkDiff(host.chunk(), host.attempt())).text,
    tests: readArtifact(host.paths.chunkTests(host.chunk(), host.attempt())).text,
    evidenceBudgetBytes: localResultBytes(limits),
    signal: host.signal(),
    onProgress: (note) => host.emit({ type: 'warning', runId: host.id, stage: 'verify', message: `ансамбль, узкий маршрут ${route.modelId}: ${note}` }),
    onUsage: (usage) => host.accountOffPathUsage('verify', usage, route.providerDef.currency),
  });

  const records: ClaimRecord[] = [];
  const haystack = evidenceHaystack(host);
  for (const call of calls) {
    if (call.kind !== 'record_claim') continue;
    const anchored = anchorFound(call.evidence, haystack);
    records.push({
      id: call.id,
      status: call.status,
      evidence: anchored ? call.evidence : `${call.evidence} _(ссылка не найдена в патче попытки)_`,
      whatToFix: call.whatToFix,
    });
  }

  const { text } = renderRecords(host.verifyState.verifyPrefill ?? readArtifact(canonical).text, {
    claims: records,
    findings: [],
  });
  writeArtifact(canonical, text);
  host.emit({
    type: 'warning',
    runId: host.id,
    stage: 'verify',
    message:
      `ансамбль, узкий маршрут ${route.modelId}: спрошено ${claims.length} неуверенных ` +
      `пункт(ов), разобрано ответов — ${records.length}. Статусы сводятся по худшему, ` +
      `как у любого маршрута`,
  });
  // Частичный отчёт маршрута уже записан выше — бросаем ПОСЛЕ, чтобы уже собранные
  // ответы не терялись. Вызывающий (`runEnsembleReviewers`) ловит `ProviderEnvError`
  // отдельно и печатает настоящую причину («узкий маршрут не отработал: …»), а не
  // общее «разобрано ответов — 0», неотличимое от того, что модель просто промолчала
  // на все пункты (см. докстринг `ClaimFillResult.envFailure`).
  if (envFailure !== null) throw new ProviderEnvError(envFailure);
}

/**
 * Дополнительные маршруты ансамбля рецензентов. Только этап 6 и только он.
 *
 * Ансамбль на пишущем этапе — это второй исполнитель, который правит те же файлы поверх
 * готового патча первого: улика попытки становится смесью двух авторов, а детект
 * отсутствия прогресса сравнивает патчи, собранные разным числом рук. Поэтому ограничение
 * стоит здесь, в рантайме, а не держится на том, что так никто не сконфигурирует.
 *
 * Каждый маршрут пишет в канонический путь отчёта (его называет промпт этапа), а рантайм
 * сразу переносит написанное в путь маршрута. Так вердикт получает ВСЕ мнения, а не
 * последнее записанное, и при этом ни промпт, ни имя основного артефакта не меняются.
 */
export async function runEnsembleReviewers(
  host: StageHost,
  prompt: PreparedPrompt,
  def: StageDef,
  agents: readonly SubagentDef[],
  hooks: ExecHooks,
): Promise<void> {
  const extraRoutes = host.ensembleRoutes().slice(1);
  const signal = host.aborterSignal();
  if (extraRoutes.length === 0 || signal === undefined) return;
  const verify = host.verifyState;

  const canonical = host.paths.verificationReport(host.chunk(), host.attempt(), 0);
  const primary = readArtifact(canonical).text;
  // Записи основного маршрута сохраняются и возвращаются после ансамбля: маршруты пишут
  // в те же `claimRecords`/`findingRecords` через общие хуки, и бриф ретрая (`retryDetail`,
  // читается после ансамбля) нёс бы «что чинить» последнего, самого слабого маршрута под
  // подписью «по словам рецензента», а находки — дублями от каждого маршрута.
  const primaryClaims = new Map(verify.claimRecords);
  const primaryFindings = [...verify.findingRecords];

  for (const [i, other] of extraRoutes.entries()) {
    if (host.aborterSignal()?.aborted === true) break;
    const route = i + 1;
    host.emit({
      type: 'warning',
      runId: host.id,
      stage: 'verify',
      message: `ансамбль: дополнительный маршрут ${route + 1} — ${other.modelId}`,
    });

    // Канонический файл сбрасывается к бланку, заполненному рантаймом (таблица гейтов,
    // механика шапки), — чтобы следующий рецензент не дописывал в чужой отчёт, но и не
    // сочинял таблицу гейтов от себя. Бланка нет (автозаполнение не отработало) —
    // прежнее поведение, пустой файл.
    writeArtifact(canonical, verify.verifyPrefill ?? '');
    // Записи маршрута — его собственные: без сброса `RecordClaim` полного маршрута смешивался
    // бы с пунктами основного, а рендер ниже нёс бы в отчёт маршрута чужое мнение.
    verify.claimRecords = new Map();
    verify.findingRecords = [];
    let narrowed = false;
    try {
      // Узкий маршрут: спросить сильную модель ТОЛЬКО о пунктах, в которых слабая не
      // уверена (`⚠`), вместо полного второго ревью. Дешевле в разы — замер r18 назвал
      // цену независимости цифрой: контроль в 11 раз дороже и в 7 раз медленнее при
      // одинаковом вердикте.
      //
      // Статусы при этом НЕ переписываются: ответ уходит в отчёт СВОЕГО маршрута, и
      // вердикт сводит маршруты как всегда — по худшему статусу. Заменять `⚠` слабой
      // модели зелёным сильной значило бы двигать вердикт к зелёному по слову модели, а
      // это ровно то, против чего написано правило «худший из двух».
      if (other.claimFill && other.flow === 'loop') {
        const uncertain = uncertainClaims(host, primary);
        // Без `continue`: он перескакивал перенос канонического файла в файл маршрута ниже, и
        // ответы узкого маршрута затирались основным отчётом — второе мнение не доходило до
        // вердикта (code-review-all, 2026-09-15).
        if (uncertain.length > 0) {
          narrowed = true;
          await narrowRoute(host, other, prompt, canonical, uncertain);
        }
      }

      if (!narrowed) await host.executorFor('verify', other).run(
        {
          prompt,
          cwd: host.projectRoot,
          model: other.model,
          allowedTools: host.toolsFor('verify'),
          // Тот же набор, что у первого маршрута: соединения уже подняты, отбор посчитан.
          mcp: await host.mcpAccess('verify'),
          // Стража нет: канонический файл отчёта здесь намеренно опустошён перед каждым
          // маршрутом ансамбля, и «артефакт на месте» тут не признак сделанной работы.
          finishGuard: null,
          // Субагент артефактов этапа не производит — спасать нечего.
          salvageFromText: null,
          readOnlyDirs: host.readOnlyRoots(),
          subagents: agents,
          maxTurns: host.maxTurnsFor('verify'),
          maxBudgetUsd: host.maxBudgetUsd,
          spentUsdBefore: host.spentBefore(other.providerDef.currency ?? 'USD'),
          signal,
        },
        hooks,
      );
    } catch (e) {
      // Падение ДОПОЛНИТЕЛЬНОГО рецензента не отменяет вердикт по уже готовым отчётам:
      // пока оно улетало в общий catch этапа, работа основного маршрута выбрасывалась
      // целиком и оператор возвращался к попытке с нуля.
      host.emit({
        type: 'warning',
        runId: host.id,
        stage: 'verify',
        message:
          `ансамбль: маршрут ${route + 1} (${other.modelId}) не отработал: ` +
          `${(e as Error).message}. Вердикт считается по отчётам остальных.`,
      });
    }
    // Записи полного маршрута (`RecordClaim`/`RecordFinding` через общие хуки) вносятся в его
    // отчёт тем же рендером, что у основного (`applyRecords`): маршрут, отчитавшийся только
    // инструментами, как велит промпт, иначе оставлял бланк — и свод по худшему считал каждый
    // пункт `⚠`. Запись напрямую, как у узкого маршрута: канонический файл — рабочая копия
    // ансамбля, а не артефакт, который правит модель.
    if (!narrowed && (verify.claimRecords.size > 0 || verify.findingRecords.length > 0)) {
      const { text } = renderRecords(readArtifact(canonical).text, {
        claims: [...verify.claimRecords.values()],
        findings: verify.findingRecords,
        titles: new Map([...host.intentClaimLines()].map(([id, line]) => [id, claimTextCell(line)] as const)),
      });
      writeArtifact(canonical, text);
    }
    writeArtifact(host.paths.verificationReport(host.chunk(), host.attempt(), route), readArtifact(canonical).text);
  }

  // Канонический путь возвращается основному маршруту: его читают скиллы `/sdlc-*`,
  // предусловия этапов и витки, начатые в терминале.
  writeArtifact(canonical, primary);
  verify.claimRecords = primaryClaims;
  verify.findingRecords = primaryFindings;
}
