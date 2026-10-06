/**
 * Этап 6: независимое ревью, запущенное рантаймом до хода модели этапа — свободный ход
 * субагента-рецензента либо конвейер закрытых вопросов по хункам (`ModelDef.reviewFill`).
 */

import { localResultBytes } from '../../../config/limits.ts';
import type { ClaimStatus, FindingSection, PreparedPrompt, ToolName } from '@sdlc-runner/shared';

import { readArtifact } from '../../../artifacts/artifact.ts';
import { diffstat } from '../../../diff/diffstat.ts';
import { parseReviewText } from './reviewValidate.ts';
import type { ReviewFindingField, ReviewRef, ReviewStatus } from './reviewValidate.ts';
import { AXES, parsePlanAxes } from '../../../artifacts/planAxes.ts';
import type { AxisName, AxisRow } from '../../../artifacts/planAxes.ts';
import type { ResolvedRoute } from '../../../config/schema.ts';
import { REVIEWER_AGENTS } from '../../../exec/StageExecutor.ts';
import type { ExecHooks, SubagentDef } from '../../../exec/StageExecutor.ts';
import { isToolName } from '../../../exec/toolSpecs.ts';
import { createProvider } from '../../../provider/registry.ts';
import { AXIS_HINTS, reviewByHunks } from '../../reviewFill.ts';
import type { AxisAsk } from '../../reviewFill.ts';
import type { StageHost } from '../types.ts';
import { REVIEW_GATE } from './gates.ts';
import { acceptRecord } from './records.ts';
import { readBaseline } from '../chunk/evidence.ts';
import { reviewBaselineContext } from '../../reviewBaseline.ts';
import { guidedSourceHunks } from '../../guidedState.ts';
import { readGuided, guidedReviewContext } from '../../guidedState.ts';
import { preparation } from '../../../artifacts/preparation.ts';

/**
 * Все шесть осей канона — свободному ходу рецензента, тем же приёмом и по той же причине,
 * что трек 1а `reviewFill` (докстринг `run/reviewFill.ts`): план может пометить ось «не
 * затронута», хотя diff её трогает, или сослаться на пункт приёмки, который покрывает
 * совсем другое изменение под тем же ярлыком — посев `axis-config-blind` пропущен именно
 * так. `reviewFill` (флоу `loop`) эту слепоту уже не несёт; свободный ход (единственный
 * маршрут флоу `sdk`, и `loop` без `reviewFill`) её всё ещё мог — замер показал `sonnet`
 * пропускающим оба осевых посева при чистом контроле (`docs/model-runs.md`,
 * «Первый посев в истории журнала»), тогда как `opus`/`haiku` в свободном ходе их ловят.
 * Блок не задаёт вопрос (в отличие от `reviewFill` — здесь один свободный проход), а
 * снимает повод доверять тексту плана как факту: явно называет статус плана рядом с
 * инструкцией сверить его с diff'ом самому.
 *
 * `null` — плана нет (ревью без него не станет точнее подсказкой).
 */
export function axisVerificationBlock(planText: string | null): string | null {
  if (planText === null) return null;
  const rows = parsePlanAxes(planText).rows;
  // ПОСЛЕДНЯЯ строка с этим каноническим именем побеждает, не первая: при нескольких
  // строках на одну ось (повторная правка плана вручную или `applyAxisAnswers` поверх
  // старой таблицы) первая — устаревшая, актуальная всегда ниже. Простая перезапись без
  // `has()`-охраны и даёт это по построению (ревью code-review-all, 2026-09-18).
  const byAxis = new Map<AxisName, AxisRow>();
  for (const row of rows) {
    if (row.canonical !== null) byAxis.set(row.canonical, row);
  }
  const lines = AXES.map((name) => {
    const row = byAxis.get(name);
    const declared =
      row === undefined
        ? 'в плане строки нет'
        : row.affected === true
          ? 'план объявляет ЗАТРОНУТОЙ'
          : row.affected === false
            ? 'план объявляет НЕ затронутой'
            : 'план не назвал исход';
    const outcome = row?.outcomeRaw.trim();
    return `- «${name}» (${AXIS_HINTS[name]}) — ${declared}${outcome !== undefined && outcome !== '' ? `; исход по плану: ${outcome}` : ''}.`;
  });
  return [
    '## Все шесть осей — сверь с diff\'ом сам, не перенеси статус плана',
    '',
    'План мог ошибиться в любую сторону: пометить ось «не затронута», хотя diff её трогает,',
    'или сослаться на пункт приёмки, который на деле покрывает другое изменение под тем же',
    'ярлыком оси. Для каждой из шести осей ниже — проверь заявленное по самому diff\'у,',
    'а не перенеси статус плана как факт.',
    '',
    ...lines,
  ].join('\n');
}

/** ReviewFill checks every canonical readiness axis, including axes omitted by the plan. */
export function reviewAxes(planText: string | null): AxisAsk[] {
  const rows = planText === null ? [] : parsePlanAxes(planText).rows;
  const byAxis = new Map<AxisName, AxisRow>();
  for (const row of rows) if (row.canonical !== null) byAxis.set(row.canonical, row);
  const canonical = AXES.map((name) => {
    const row = byAxis.get(name);
    return { name, affected: row?.affected ?? null, outcomeRaw: row?.outcomeRaw ?? '' };
  });
  const projectDefined = rows.filter((row) => row.canonical === null).map((row) => ({
    name: row.name,
    affected: row.affected,
    outcomeRaw: row.outcomeRaw,
  }));
  return [...canonical, ...projectDefined];
}

/**
 * Отчёт независимого рецензента, прогнанного рантаймом, — блоком во вход этапа.
 *
 * Текст рецензента подаётся как ФАКТ прогона, а не как мнение, которое можно
 * переписать: ровно так же, как итоги гейтов. Отдельно сказано, что звать `Task` второй
 * раз не нужно — иначе дешёвая модель тратит ходы на повторное ревью, которое уже
 * состоялось (а анти-цикл на `Task` ×3 её же и обрывает).
 */
export function reviewerBlock(text: string, blocking = true): string {
  const intro = blocking
    ? [
        'Ревью уже проведено: рецензент запущен рантаймом на отдельном маршруте, твоего рассказа',
        'о работе он не получал. Повторно звать субагента `Task` не надо — перенеси находки в',
        '§2–§5 отчёта приёмки и учти их в статусах пунктов. Своим мнением находки не отменяй:',
        'расхождение, названное рецензентом, роняет вердикт, даже если пункта приёмки на это',
        'поведение нет.',
      ]
    : [
        'Скан ревью уже выполнен рантаймом, твоего рассказа о работе он не получал. Повторно',
        'звать субагента `Task` не надо. Скан выполнила та же модель, что и исполнитель, поэтому',
        'его находки — СПРАВОЧНЫЕ (advisory): перенеси их в отчёт отдельно, но своим мнением не',
        'отменяй — вердикт они не роняют по построению: его считает рантайм из гейтов, сверки',
        'diff с деревом и проверок честности.',
      ];
  return ['## Отчёт рецензента (прогон рантайма, этот этап)', '', ...intro, '', text].join('\n');
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
 *
 * `blocking: false` — конвейер идёт той же моделью, что исполнитель (`reviewScan`):
 * находки принимаются справочными (advisory) и вердикт не роняют.
 */
export async function runReviewFill(host: StageHost, route: ResolvedRoute, blocking = true): Promise<string | null> {
  const signal = host.aborterSignal();
  if (signal === undefined) return null;
  const diff = readArtifact(host.paths.chunkDiff(host.chunk(), host.attempt()));
  const sources = diff.exists && diff.text.trim() === '' ? guidedSourceHunks(host.paths) : [];
  if (!diff.exists || (diff.text.trim() === '' && sources.length === 0)) {
    host.emit({
      type: 'warning',
      runId: host.id,
      stage: 'verify',
      message: `ревью по хункам не запущено: патча попытки нет — гейт «${REVIEW_GATE}» остаётся ⏭`,
    });
    return null;
  }
  const plan = readArtifact(host.paths.plan);
  const axes = reviewAxes(plan.exists ? plan.text : null).map((r) => ({ name: r.name, affected: r.affected, outcomeRaw: r.outcomeRaw }));
  const intent = readArtifact(host.paths.intent);
  const taskContext = [readGuided(host.paths) ? (preparation(host.paths)?.requests ?? []).join('\n\n') : '',
    intent.exists ? [...host.intentClaimLines(intent.text).values()].join('\n') : '',
    readGuided(host.paths) ? guidedReviewContext(host.paths) : '',
    reviewBaselineContext(host.paths.projectRoot, diff.text, readBaseline(host))].filter(Boolean).join('\n\n');
  const limits = host.limits();

  const result = await reviewByHunks({
    provider: createProvider(route.provider, route.providerDef, limits.chatTimeoutMs, host.trace('verify', 'reviewFill')),
    model: route.model,
    params: route.params,
    taskContext,
    diff: diff.text,
    ...(sources.length ? { sourceHunks: sources } : {}),
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
  // Скан той же моделью, что исполнитель, — справочный: находки помечаются advisory.
  for (const call of result.findings) acceptRecord(host, call, { advisory: !blocking });

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

  // Все шесть осей — фактом во вход рецензента, не вопросом (единственный проход у
  // свободного хода). `null`, если плана нет, не добавляет пустой блок.
  const planForAxes = readArtifact(host.paths.plan);
  const axisBlock = axisVerificationBlock(planForAxes.exists ? planForAxes.text : null);
  const userWithAxes = axisBlock === null ? prompt.user : `${prompt.user}\n\n${axisBlock}`;

  // Маршрут скана — `reviewScan`: отдельный `reviewModel` из конфига раннера либо
  // маршрут этапа verify, как прежде. `blocking: false` — скан той же моделью, что
  // исполнитель: его находки принимаются справочными (advisory).
  const scan = host.reviewScan();
  const route = scan.route;
  try {
    const runOnce = async (user: string) => host.executorFor('verify', route).run(
      {
        prompt: {
          presetNote: null,
          // Тело определения агента — его системный промпт. Рассказа исполнителя здесь
          // нет и быть не может: `stageInputs('verify')` журнала chunk'а не содержит.
          system: def.prompt,
          user,
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

    let result = await runOnce(userWithAxes);
    let text = result.finalText.trim();

    // Контракт ответа (`implementations/runner-contract` методологии, `verify-review-v1`):
    // JSON-блок со статусом по КАЖДОМУ пункту задачи и адресными находками. Один
    // До двух repair-запросов с названными ошибками; затем гейт остаётся `⏭`.
    // Прежде ответ судился регулярками по markdown: хватало якоря из патча и упоминания
    // id, и «оформитель» проходил планку пересказом (code-review-all 2026-09-23).
    let accepted = result.ok && text !== '' ? acceptReviewText(host, text, 'рантайм', { advisory: !scan.blocking }) : { ok: false as const, why: 'пусто' };
    const rejectedTexts: string[] = [];
    for (let repair = 1; repair <= 2 && result.ok && text !== '' && !accepted.ok && !signal.aborted; repair += 1) {
      rejectedTexts.push(text);
      host.emit({
        type: 'warning',
        runId: host.id,
        stage: 'verify',
        message: `ответ рецензента не по контракту verify-review-v1: ${accepted.why} — повторный запрос ${repair} из 2`,
      });
      // Каждый repair — полный ответ, поэтому он
      // обязан назвать всё, что от ответа требуется, а не только то, что в нём сломано:
      // список допустимых id и путей патча — то же самое, чем ответ будет судиться повторно
      // (`reviewInputs`, единый источник с планкой), плюс минимальный скелет JSON. Прежде
      // повтор называл только ошибку и пересказывал схему словами — качественно способные
      // модели (`qwen3.6:35b-a3b`, серия 2026-09-27/28) путали форму путей, не имея перед
      // глазами ни списка допустимых значений, ни примера структуры.
      const { claimIds, patchPaths } = reviewInputs(host);
      const skeleton = JSON.stringify(
        {
          schema_version: 'agent-sdlc/verify-review/v1',
          claims: [...claimIds].map((id) => ({ id, status: 'passed|failed|uncertain|manual', evidence: [{ path: '…', anchor: '…' }], remediation: '' })),
          findings: [],
          scope: [],
          invariants: [],
          regressions: [],
          retry_instruction: '',
        },
        null,
        2,
      );
      const retry = await runOnce(
        `${userWithAxes}\n\n## Повтор ${repair} из 2: ответ не по контракту\n\nПрошлый ответ не принят целиком, ошибки: ${accepted.why}.\n\n` +
          `Исправь оформление, сохрани найденные дефекты и неопределённости. Предыдущий ответ (справочно):\n${text.slice(0, 12000)}\n\n` +
          `Допустимые id пунктов приёмки (ровно эти, не больше и не меньше): ${[...claimIds].join(', ')}.\n` +
          `Пути патча этой попытки (ссылки evidence обязаны называть один из них — либо ` +
          `intent.md/plan.md/gates.md для находок про артефакты): ${[...patchPaths].join(', ') || '(патч пуст)'}.\n\n` +
          'Дай ответ заново целиком: fenced-блок ```json по схеме verify-review-v1 — `claims` по КАЖДОМУ ' +
          'пункту приёмки задачи (id, status из passed|failed|uncertain|manual, evidence с path и anchor), ' +
          'находки в `findings`/`scope`/`invariants`/`regressions` с evidence из патча, `retry_instruction` строкой. ' +
          `Скелет структуры (заполни реальными значениями, не копируй плейсхолдеры):\n\`\`\`json\n${skeleton}\n\`\`\``,
      );
      if (retry.ok && retry.finalText.trim() !== '') {
        // Планки судят ПОВТОРНЫЙ ответ целиком — его просили быть полным; объединение
        // двух неполных ответов прежде проходило как полное ревью. Первый ответ всё равно
        // уходит во вход этапа (его находки иначе терялись), но подписан как справочный,
        // чтобы два статуса одного пункта не читались как равноправные (code-review-all
        // 2026-09-23).
        const judged = retry.finalText.trim();
        accepted = acceptReviewText(host, judged, 'рантайм, повтор', { advisory: !scan.blocking });
        text = judged;
      }
      result = retry;
    }
    if (rejectedTexts.length > 0) {
      text += rejectedTexts.map((previous, index) =>
        `\n\n## Отклонённый ответ рецензента ${index + 1} (не по контракту — только для справки; итог — ответ выше)\n\n${previous}`,
      ).join('');
    }
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

    if (!accepted.ok) {
      host.emit({
        type: 'warning',
        runId: host.id,
        stage: 'verify',
        message: `ответ рецензента не по контракту verify-review-v1: ${accepted.why}. Гейт «${REVIEW_GATE}» остаётся ⏭, текст всё равно уходит во вход этапа`,
      });
      return text;
    }

    // Факт ревью ставится ТОЛЬКО по ответу, прошедшему контракт, — тем же правилом, что и
    // при вызове субагента моделью (`Run`, `onToolResult`): «ход завершён» ревью не является.
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

/**
 * Данные, по которым `parseReviewText` судит ответ: id пунктов задачи и пути патча
 * попытки. Один читатель на планку (`acceptReviewText`) и на repair-промпт
 * (`runReviewerDirectly`) — иначе список, который отдаём модели как «допустимо», и список,
 * по которому её реально судят, могли бы разойтись при первой же правке одного из мест.
 */
export function reviewInputs(host: StageHost): { claimIds: Set<string>; patchPaths: Set<string> } {
  const claimIds = new Set([...host.intentClaimLines().keys()].map((c) => c.toLowerCase()));
  const patch = readArtifact(host.paths.chunkDiff(host.chunk(), host.attempt()));
  const patchPaths = new Set(patch.exists ? diffstat(patch.text).paths : []);
  return { claimIds, patchPaths };
}

/**
 * Ответ рецензента → контракт `verify-review-v1` → записи отчёта. Валидный ответ даёт
 * записи пунктов (`RecordClaim`) и находок (`RecordFinding`) тем же путём, что записи
 * модели (`acceptRecord`: сверка ссылки с патчем, рендер рантайма), и запоминается для
 * `.chunk-N-attempt-K-review.json`. `ok: false` — ответ не принят, причина названа.
 */
export function acceptReviewText(host: StageHost, text: string, source: string, opts?: { advisory?: boolean }): { ok: true } | { ok: false; why: string } {
  const { claimIds, patchPaths } = reviewInputs(host);
  const v = parseReviewText(text, claimIds, patchPaths);
  // Прежде — только первые 6 ошибок: repair-запрос строится ИЗ `why`, и обрезанный список
  // прятал от модели часть контракта, который она нарушила (серия 2026-09-27/28). Полный
  // список — все реальные ответы дают счёт ошибок в единицах (по одной на находку/claim),
  // а не сотни; жёсткий потолок на этот случай не нужен.
  if (!v.valid || v.review === null) return { ok: false, why: v.errors.join('; ') };
  const review = v.review;
  const glyph: Record<ReviewStatus, ClaimStatus> = { passed: '✅', failed: '❌', uncertain: '⚠', manual: 'manual' };
  const refs = (list: readonly ReviewRef[]): string => list.map((r) => `${r.path}:${r.anchor}`).join('; ');
  for (const c of review.claims) {
    acceptRecord(host, { kind: 'record_claim', id: c.id, status: glyph[c.status], evidence: refs(c.evidence), whatToFix: c.remediation === '' ? null : c.remediation });
  }
  const sections: [ReviewFindingField, FindingSection][] = [
    ['findings', 'review'],
    ['scope', 'scope'],
    ['invariants', 'invariant'],
    ['regressions', 'regression'],
  ];
  for (const [field, section] of sections) {
    for (const f of review[field]) {
      acceptRecord(host, { kind: 'record_finding', section, text: f.summary, evidence: refs(f.evidence) }, opts);
    }
  }
  host.verifyState.reviewJson = review;
  host.verifyState.reviewText = text;
  host.emit({
    type: 'warning',
    runId: host.id,
    stage: 'verify',
    message:
      `ответ рецензента (${source}) принят по контракту verify-review-v1: пунктов ${review.claims.length}, ` +
      `находок ${review.findings.length + review.scope.length + review.invariants.length + review.regressions.length}`,
  });
  return { ok: true };
}
