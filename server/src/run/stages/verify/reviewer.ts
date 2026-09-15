/**
 * Этап 6: независимое ревью, запущенное рантаймом до хода модели этапа — свободный ход
 * субагента-рецензента либо конвейер закрытых вопросов по хункам (`ModelDef.reviewFill`).
 */

import { localResultBytes } from '../../../config/limits.ts';
import type { PreparedPrompt, ToolName } from '@sdlc-runner/shared';

import { readArtifact } from '../../../artifacts/artifact.ts';
import { parsePlanAxes } from '../../../artifacts/planAxes.ts';
import type { ResolvedRoute } from '../../../config/schema.ts';
import { REVIEWER_AGENTS } from '../../../exec/StageExecutor.ts';
import type { ExecHooks, SubagentDef } from '../../../exec/StageExecutor.ts';
import { isToolName } from '../../../exec/toolSpecs.ts';
import { createProvider } from '../../../provider/registry.ts';
import { reviewByHunks } from '../../reviewFill.ts';
import { anchorFound } from '../../verifyReport.ts';
import type { StageHost } from '../types.ts';
import { REVIEW_GATE } from './gates.ts';
import { acceptRecord, evidenceHaystack } from './records.ts';

/**
 * Отчёт независимого рецензента, прогнанного рантаймом, — блоком во вход этапа.
 *
 * Текст рецензента подаётся как ФАКТ прогона, а не как мнение, которое можно
 * переписать: ровно так же, как итоги гейтов. Отдельно сказано, что звать `Task` второй
 * раз не нужно — иначе дешёвая модель тратит ходы на повторное ревью, которое уже
 * состоялось (а анти-цикл на `Task` ×3 её же и обрывает).
 */
export function reviewerBlock(text: string): string {
  return [
    '## Отчёт независимого рецензента (прогон рантайма, этот этап)',
    '',
    'Ревью уже проведено: рецензент запущен рантаймом на отдельном маршруте, твоего рассказа',
    'о работе он не получал. Повторно звать субагента `Task` не надо — перенеси находки в',
    '§2–§5 отчёта приёмки и учти их в статусах пунктов. Своим мнением находки не отменяй:',
    'расхождение, названное рецензентом, роняет вердикт, даже если пункта приёмки на это',
    'поведение нет.',
    '',
    text,
  ].join('\n');
}

/**
 * Ревью по хункам (`ModelDef.reviewFill`): конвейер закрытых вопросов вместо
 * свободного хода рецензента — см. шапку `run/reviewFill.ts`.
 *
 * Гейт «Ревью независимым агентом» ставится по факту, который рантайм видел сам:
 * каждый фрагмент патча показан модели и на каждый получен ответ. Планка якоря здесь
 * не нужна — чтение diff'а обеспечено конструкцией, а не доверием к тексту; сводка и
 * так называет проверенные файлы. Неполный конвейер (упавшие запросы) гейт не зеленит.
 *
 * `null` — ревью не состоялось: патча нет, либо прогон отменён до первого вопроса.
 */
export async function runReviewFill(host: StageHost, route: ResolvedRoute): Promise<string | null> {
  const signal = host.aborterSignal();
  if (signal === undefined) return null;
  const diff = readArtifact(host.paths.chunkDiff(host.chunk(), host.attempt()));
  if (!diff.exists || diff.text.trim() === '') {
    host.emit({
      type: 'warning',
      runId: host.id,
      stage: 'verify',
      message: `ревью по хункам не запущено: патча попытки нет — гейт «${REVIEW_GATE}» остаётся ⏭`,
    });
    return null;
  }
  const plan = readArtifact(host.paths.plan);
  const axes = plan.exists
    ? parsePlanAxes(plan.text).rows.map((r) => ({ name: r.name, affected: r.affected, outcomeRaw: r.outcomeRaw }))
    : [];
  const intent = readArtifact(host.paths.intent);
  const taskContext = intent.exists ? [...host.intentClaimLines(intent.text).values()].join('\n') : '';
  const limits = host.limits();

  const result = await reviewByHunks({
    provider: createProvider(route.provider, route.providerDef, limits.chatTimeoutMs, host.trace('verify', 'reviewFill')),
    model: route.model,
    params: route.params,
    taskContext,
    diff: diff.text,
    axes,
    // Тот же потолок, что у среза патча в поклаймовом доборе: фрагмент конкурирует за
    // то же окно локальной модели.
    hunkBudgetBytes: localResultBytes(limits),
    signal,
    onProgress: (note) => host.emit({ type: 'warning', runId: host.id, stage: 'verify', message: `ревью по хункам: ${note}` }),
    onUsage: (usage) => host.accountOffPathUsage('verify', usage, route.providerDef.currency),
  });

  // Находки проходят тем же приёмом, что записи модели: проверка ссылки, рендер
  // рантайма, гейт одобрения. Второго места, знающего форму записи, не появляется.
  for (const call of result.findings) acceptRecord(host, call);

  // Оба конвейера обязаны дойти до конца — не только хунки. Докстринг
  // `skipTurnAfterReviewFill` определяет «конвейер прошёл целиком» как «все хунки И все
  // спрошенные оси отвечены»; до этой правки ось, упавшая отдельным батчем ПОСЛЕ хунков
  // (см. `reviewByHunks`), не мешала считать проход полным — гейт «Ревью независимым
  // агентом» зеленел, а осевая сверка (весь смысл трека 1а — ловить `axis-config-blind`)
  // тихо не состоялась.
  const complete =
    result.hunksAsked > 0 && result.hunksAnswered === result.hunksAsked && result.axesAnswered === result.axesAsked;
  host.verifyState.reviewFillComplete = complete;
  if (complete) host.markReviewerRan();
  host.emit({
    type: 'warning',
    runId: host.id,
    stage: 'verify',
    message:
      `ревью по хункам: фрагментов ${result.hunksAnswered}/${result.hunksAsked}, осей ` +
      `${result.axesAnswered}/${result.axesAsked}, находок ${result.findings.length}` +
      (complete ? '' : ` — конвейер неполный, гейт «${REVIEW_GATE}» остаётся ⏭`),
  });
  return result.text;
}

/**
 * Независимое ревью, запущенное РАНТАЙМОМ, а не просьбой в промпте.
 *
 * Методология требует ревью другим агентом, не получающим рассказ исполнителя. До сих
 * пор это держалось на том, что модель этапа догадается позвать `Task` — и на дешёвой
 * полке это ровно тот шаг, который не случается: замеры дали и залипание анти-цикла на
 * `Task` ×3 (`qwen3-14b`), и уход хода в оболочку вместо вызова, и просто нехватку ходов
 * до вызова. Раз гейты рантайм прогоняет сам, ревью — та же природа: обязательный шаг
 * этапа, а не поручение.
 *
 * Вход рецензента — пользовательское сообщение этапа как есть: методология перечисляет
 * его входы исчерпывающе (задача, план, набор гейтов, diff), и `stageInputs` собирает
 * ровно их, без журнала исполнителя. Второго места сборки входа не появляется.
 *
 * `null` — ревью не состоялось (определения агента нет, прав нет, прогон упал). Этап
 * при этом не падает: у модели остаётся `Task`, а гейт «Ревью независимым агентом»
 * честно останется `⏭`, если не отработал никто.
 */
export async function runReviewerDirectly(
  host: StageHost,
  prompt: PreparedPrompt,
  agents: readonly SubagentDef[],
  hooks: ExecHooks,
): Promise<string | null> {
  const def = agents.find((a) => REVIEWER_AGENTS.includes(a.name));
  const signal = host.aborterSignal();
  if (def === undefined || signal === undefined) return null;

  // Права — то же пересечение, что и у субагента, вызванного моделью: ни расширить
  // права этапа прогоном рантайма, ни выдать рецензенту больше объявленного нельзя.
  // Пустое пересечение — не ревью, а прогон вслепую (тот же отказ, что в LoopExecutor).
  const stageTools = host.toolsFor('verify');
  const declared = def.tools === null ? null : def.tools.filter((t): t is ToolName => isToolName(t));
  const allowed = declared === null ? stageTools : stageTools.filter((t) => declared.includes(t));
  if (allowed.length === 0) {
    host.emit({
      type: 'warning',
      runId: host.id,
      stage: 'verify',
      message:
        `рецензент «${def.name}» не получил ни одного инструмента: пересечение прав этапа и ` +
        `объявленных им пусто — ревью рантаймом не запускается`,
    });
    return null;
  }

  const route = host.verifyRoute();
  try {
    const result = await host.executorFor('verify', route).run(
      {
        prompt: {
          presetNote: null,
          // Тело определения агента — его системный промпт. Рассказа исполнителя здесь
          // нет и быть не может: `stageInputs('verify')` журнала chunk'а не содержит.
          system: def.prompt,
          user: prompt.user,
          tools: [],
          editedByOperator: false,
        },
        cwd: host.projectRoot,
        model: route.model,
        allowedTools: allowed,
        readOnlyDirs: host.readOnlyRoots(),
        // Одноуровневость: рецензент не разворачивает своих субагентов.
        subagents: [],
        mcp: await host.mcpAccess('verify'),
        // Артефакт этапа пишет модель этапа, а не рецензент: он возвращает текст.
        finishGuard: null,
        salvageFromText: null,
        maxTurns: host.maxTurnsFor('verify'),
        maxBudgetUsd: host.maxBudgetUsd,
        spentUsdBefore: host.spentBefore(route.providerDef.currency ?? 'USD'),
        signal,
      },
      hooks,
    );

    const text = result.finalText.trim();
    if (!result.ok || text === '') {
      // Причина обязана быть НАЗВАНА, а не сведена к «пусто»: живой прогон дал
      // `ok=true`, 1174 выходных токена и пустой текст — то есть рецензент потратил ход
      // на вызовы инструментов (часть — по протухшим абсолютным путям из артефактов
      // снимка) и не сказал ни слова. По сообщению «вернул пустой ответ» это неотличимо
      // от модели, которая просто промолчала, а чинится это разными способами.
      host.emit({
        type: 'warning',
        runId: host.id,
        stage: 'verify',
        message:
          `ревью рантаймом не состоялось: ${result.ok ? 'рецензент не вернул текста' : result.note}. ` +
          `Исход прогона: ${result.note}; израсходовано токенов на выходе: ${result.usage.outputTokens}. ` +
          `Гейт «${REVIEW_GATE}» зелёным от этого не станет`,
      });
      return null;
    }

    // Планка содержательности: ответ обязан ссылаться на МЕСТО из патча попытки.
    // Замер r9 дал класс «оформитель» — `gpt-oss-20b` закрыла бланк за ₽0.48, пометив
    // все гейты «⏭ не запускался» и не найдя ничего: прогон состоялся, ревью — нет.
    // Отличить одно от другого можно ровно так: рецензент, читавший diff, называет
    // файлы и символы из него. Планка низкая намеренно — достаточно одного совпадения.
    if (!anchorFound(text, evidenceHaystack(host))) {
      host.emit({
        type: 'warning',
        runId: host.id,
        stage: 'verify',
        message:
          `рецензент отработал, но в его ответе нет ни одной ссылки на место из патча ` +
          `попытки — прогон состоялся, ревью не состоялось. Гейт «${REVIEW_GATE}» остаётся ⏭, ` +
          `текст всё равно уходит во вход этапа`,
      });
      return text;
    }

    // Факт ревью ставится ТОЛЬКО по непустому ответу состоявшегося прогона — тем же
    // правилом, что и при вызове субагента моделью: «ход завершён» ревью не является.
    host.markReviewerRan();
    return text;
  } catch (e) {
    // Падение рецензента не роняет этап: у модели остаётся собственный `Task`, а
    // несостоявшееся ревью честно видно по `⏭` гейта минимума.
    host.emit({
      type: 'warning',
      runId: host.id,
      stage: 'verify',
      message: `ревью рантаймом упало: ${(e as Error).message}. Гейт «${REVIEW_GATE}» останется ⏭`,
    });
    return null;
  }
}
