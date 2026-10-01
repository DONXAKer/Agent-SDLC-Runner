/** Этап 4 — план витка: определение этапа и проверка `files_to_touch`. */

import { existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { isPreparationV2, requirementProblem, preparationReviewProblem } from '../../artifacts/preparation.ts';
import { reviewPreparation } from '../preparationReview.ts';

import type { NormalizedCall } from '@sdlc-runner/shared';

import { DECISION, artifactExists, hasNamedInvariants, readArtifact, readDecision, writeArtifact } from '../../artifacts/artifact.ts';
import { SDLC_DIR } from '../../artifacts/paths.ts';
import { planAxisProblems, unansweredAxes } from '../../artifacts/planAxes.ts';
import {
  addedBeyondPlanPaths,
  excludedFromPlanPaths,
  extractFilesToTouch,
  seedFilesToTouch,
  touchListEntries,
} from '../../artifacts/planFiles.ts';
import { explicitStepProblems, extractExplicitSteps, planSteps } from '../../artifacts/planSteps.ts';
import { addRequirementsHash, readRequirementsHash, resolvedRequirementsHash } from '../../artifacts/resolvedRequirements.ts';
import { clarificationResolutionBlock, clarificationResolutionProblem } from '../../artifacts/clarificationResolution.ts';
import { claimIdOf } from '../../artifacts/claims.ts';
import { applyAxisAnswers } from '../../artifacts/renderAxes.ts';
import type { ResolvedRoute } from '../../config/schema.ts';
import { gateKey } from '../../gates/gatesFile.ts';
import { readTree } from '../../explore/tree.ts';
import { callersOf } from '../../explore/symbols.ts';
import { capBytes } from '../../prompt/bytes.ts';
import type { GatesFile } from '../../gates/gatesFile.ts';
import { h2SectionRanges } from '../../md/table.ts';
import { ProviderEnvError } from '../../provider/ChatProvider.ts';
import { createProvider } from '../../provider/registry.ts';
import { autofillPlan, autofillReadiness } from '../formAutofill.ts';
import { hasRuntimeReadiness, readinessRun2 } from '../readinessChecks.ts';
import { fillPlanAxes } from '../planAxisFill.ts';
import { fillPlanAxesStepwise } from '../planAxisStepwise.ts';
import { explorationPathsExist } from './explore.ts';
import { claimsMinimum, hasOpenQuestions, intentFilled, intentSectionsIntact, isSmallContour, relOf } from './preconditions.ts';
import { ensureIntentSnapshot } from './intent.ts';
import type { StageContext, StageDef, StageHost, StageModule } from './types.ts';

/**
 * `files_to_touch` плана пуст — та же находка, что уже ловит `Run.blockers()` на входе в
 * `chunk` (`PlanScope выключился бы молча`), но здесь она приходит модели в её собственном
 * ходу на этапе `plan`, а не после ухода планировщика: без этой проверки виток тратил целый
 * холостой цикл — план закрывался зелёным, а бесполезность вскрывалась только на входе в
 * `chunk` (живой замер `gemma-4-e4b`/`security-bait`, 2026-09-13). Пустой список никогда не
 * легитимен в текущей архитектуре: `chunk.skipIf` отсутствует, `planScope.ts` трактует
 * пустой `files_to_touch` как «защита выключена», а не как «нечего трогать».
 *
 * Переиспользует `extractFilesToTouch` — тот же разбор секции, что и `Run.planFilesFor`
 * (второй парсер здесь завёл бы риск расхождения, см. предупреждение в `planFiles.ts`).
 */
export function filesToTouchProblem(c: StageContext): string | null {
  const plan = readArtifact(c.paths.plan);
  if (!plan.exists) return null; // отсутствие плана ловит соседнее предусловие
  if (extractFilesToTouch(plan.text).length > 0) return null;
  return (
    `в files_to_touch плана нет ни одного пути: без него PlanScope выключится молча на ` +
    `этапе 5, и запись перестанет быть ограниченной планом. Впиши хотя бы один путь строкой ` +
    `таблицы.`
  );
}

/**
 * `files_to_touch` плана против «Что придётся тронуть» разведки (4.1): каждое расхождение
 * обязано быть объяснено строкой плана, а не молча — план вправе сузить или расширить
 * список (шаблон говорит это прямо), но не вправе разойтись с разведкой БЕЗ причины.
 *
 * Пустой список разведки не проверяется (мелкий контур, разведки не было — сверять не с
 * чем, это законно). Путь разведки, отсутствующий в `files_to_touch`, обязан быть назван в
 * «Из задачи исключено»; путь `files_to_touch`, которого нет в разведке, — в «Добавлено
 * сверх разведки». Оба скана — общим `planFiles.ts::pathsAfterLabel`, второй копии не
 * заводится.
 */
export function planTouchDiscrepancyProblem(c: StageContext): string | null {
  const intent = readArtifact(c.paths.intent);
  if (!intent.exists) return null; // отсутствие задачи ловит соседнее предусловие
  const touch = touchListEntries(intent.text).map((e) => e.path);
  if (touch.length === 0) return null;

  const plan = readArtifact(c.paths.plan);
  if (!plan.exists) return null; // отсутствие плана ловит соседнее предусловие
  const files = extractFilesToTouch(plan.text);
  const excluded = excludedFromPlanPaths(plan.text);
  const added = addedBeyondPlanPaths(plan.text);

  const droppedSilently = touch.filter((p) => !files.includes(p) && !excluded.includes(p));
  const addedSilently = files.filter((p) => !touch.includes(p) && !added.includes(p));
  if (droppedSilently.length === 0 && addedSilently.length === 0) return null;

  const parts: string[] = [];
  if (droppedSilently.length > 0) {
    parts.push(
      `в files_to_touch нет и в «Из задачи исключено» не названы: ${droppedSilently.join(', ')}`,
    );
  }
  if (addedSilently.length > 0) {
    parts.push(
      `в files_to_touch есть, а в «Что придётся тронуть» и в «Добавлено сверх разведки» — нет: ` +
        addedSilently.join(', '),
    );
  }
  return `files_to_touch разошёлся с «Что придётся тронуть» разведки без объяснения — ${parts.join('; ')}.`;
}

/**
 * Явная форма шага (`### Шаг N`, `artifacts/planSteps.ts::extractExplicitSteps`) — со
 * строкой-образцом из шаблона (`templates/plan.template.md`), не заполненная по существу.
 *
 * Найдено серией local6 (2026-09-24): модель дважды меняла заголовок шага и поле
 * «действие», но оставляла `файл: src/tariffs.ts`, `символ: priceFor`, `закрывает:
 * claim-2, claim-4`, `проверка: node --test test/oversize.test.ts` — дословно текстом
 * образца. `src/tariffs.ts` не входил ни в `files_to_touch`, ни в проект, и явно не был
 * помечен новым — а не будь этой проверки, chunk потом читал `test/oversize.test.ts`
 * как реальный файл (`Read` на несуществующий путь, потерянные ходы).
 *
 * Проверяется только `файл`, не `проверка`: у `проверка` legит-форма почти всегда
 * называет ЕЩЁ НЕ СУЩЕСТВУЮЩИЙ тестовый файл (создаётся тем же шагом на chunk'е) —
 * проверка по этому полю дала бы находку на каждом нормальном плане. `файл` — путь,
 * который шаг РЕДАКТИРУЕТ, и он обязан быть либо уже объявлен (`files_to_touch`), либо
 * явно помечен новым, либо реально существовать; если ни то, ни другое, ни третье —
 * это чужой путь, дошедший из необновлённого образца.
 */
export function planStepSampleTextProblem(c: StageContext): string | null {
  const plan = readArtifact(c.paths.plan);
  if (!plan.exists) return null;
  const steps = extractExplicitSteps(plan.text);
  if (steps.length === 0) return null;
  const files = extractFilesToTouch(plan.text);
  for (const step of steps) {
    if (files.includes(step.file) || step.isNew) continue;
    if (existsSync(join(c.paths.projectRoot, step.file))) continue;
    return (
      `явная форма шага ${step.n} называет файл «${step.file}» — его нет ни в files_to_touch, ` +
      `ни на диске, и он не помечен новым. Похоже на нетронутую строку-образец шаблона плана ` +
      `(файл/символ/проверка скопированы из примера явной формы) — впиши настоящий путь этого ` +
      `шага или подтверди в files_to_touch.`
    );
  }
  return null;
}

/** Структура шагов и адресуемость claims проверяются до завершения plan. */
export function planStepsProblem(c: StageContext): string | null {
  const plan = readArtifact(c.paths.plan);
  if (!plan.exists) return null;
  // Existing plans in the legacy files_to_touch form stay on the locator fallback.
  if (extractExplicitSteps(plan.text).length === 0) return null;
  const problems = explicitStepProblems(plan.text);
  if (problems.length === 0) return null;
  return `карточки шагов плана не готовы:\n${problems.map((p) => `- ${p}`).join('\n')}`;
}

/**
 * Сверяет адреса явного плана с текущим деревом до начала chunk. Это ранняя защита от
 * устаревшей карты; старые планы остаются на прежнем locator-пути и не блокируются.
 */
export function planMapProblem(c: StageContext): string | null {
  const plan = readArtifact(c.paths.plan);
  if (!plan.exists) return null;
  const requirementProblem = planRequirementsProblem(c);
  if (requirementProblem !== null) return requirementProblem;
  const clarificationProblem = planClarificationProblem(c, plan.text);
  if (clarificationProblem !== null) return clarificationProblem;
  const steps = extractExplicitSteps(plan.text);
  if (steps.length === 0) return null;
  const files = new Set(extractFilesToTouch(plan.text));
  const index = readTree(c.paths.projectRoot);
  const issues: string[] = [];
  for (const step of steps) {
    if (!files.has(step.file)) {
      issues.push(`шаг ${step.n}: ${step.file} отсутствует в files_to_touch`);
      continue;
    }
    if (step.isNew) continue;
    const indexed = index.files.find((f) => f.path === step.file);
    if (indexed === undefined) {
      if (!existsSync(join(c.paths.projectRoot, step.file))) {
        issues.push(`шаг ${step.n}: существующий файл ${step.file} не найден`);
      }
      continue; // неиндексируемые форматы не дают надёжной проверки символов
    }
    if (step.symbol !== null && !indexed.symbols.some((symbol) => symbol.name === step.symbol)) {
      issues.push(`шаг ${step.n}: символ ${step.symbol} не найден в ${step.file}`);
    }
  }
  const callersProblem = planCallersProblem(c, plan.text, index);
  if (callersProblem !== null) issues.push(callersProblem);
  return issues.length === 0
    ? null
    : `карта плана разошлась с кодовой базой; вернись на этап 4 до расхода попытки:\n${issues.map((p) => `- ${p}`).join('\n')}`;
}

/** Every recorded human answer must be explicitly reconciled in the approved plan. */
export function planClarificationProblem(c: StageContext, planText?: string): string | null {
  const plan = planText ?? readArtifact(c.paths.plan).text;
  const report = readArtifact(c.paths.clarificationReport);
  const intent = readArtifact(c.paths.intent);
  const acceptedClaimIds = new Set(
    (intent.exists ? intent.text : '').split(/\r?\n/)
      .map(claimIdOf)
      .filter((claimId): claimId is string => claimId !== null),
  );
  return clarificationResolutionProblem(plan, report.exists ? report.text : '', acceptedClaimIds, isPreparationV2(c.paths));
}

/** Require a per-callsite disposition for every indexed caller of a changed contract. */
export function planCallersProblem(
  c: StageContext,
  planText?: string,
  indexOverride?: ReturnType<typeof readTree>,
): string | null {
  const plan = planText ?? readArtifact(c.paths.plan).text;
  const steps = extractExplicitSteps(plan).filter(
    (step) => step.contractChange !== null && !/^н\s*\/\s*п\b/i.test(step.contractChange),
  );
  if (steps.length === 0) return null;
  const index = indexOverride ?? readTree(c.paths.projectRoot);
  const sectionStart = plan.search(/^##\s+Затронутые вызовы\/сигнатуры\s*$/im);
  const section = sectionStart < 0 ? '' : (plan.slice(sectionStart).split(/^##\s+/m).slice(1)[0] ?? '');
  const rows = section.split(/\r?\n/).filter((line) => /^\s*\|/.test(line)).map((line) =>
    line.split('|').slice(1, -1).map((cell) => cell.replace(/`/g, '').trim()),
  );
  const filesToTouch = new Set(extractFilesToTouch(plan));
  const missing: string[] = [];
  for (const step of steps) {
    if (step.isNew) continue;
    if (step.symbol === null) {
      missing.push(`шаг ${step.n}: меняющийся контракт не привязан к символу`);
      continue;
    }
    const file = index.files.find((candidate) => candidate.path === step.file);
    if (file === undefined || !file.symbols.some((symbol) => symbol.name === step.symbol && symbol.exported)) continue;
    const callers = callersOf(index, step.symbol, step.file, index.files.length);
    const matchingRows = rows.filter((row) => row[0] === `${step.file}:${step.symbol}`);
    for (const caller of callers) {
      const address = `${caller.path}:${caller.line}`;
      const addressed = matchingRows.some((row) =>
        (row[2] ?? '').split(/[;,]/).some((part) => part.trim().replace(/\s+\([^)]*\)$/, '') === address) &&
        (filesToTouch.has(caller.path)
          ? /^да(?:\s|$)/i.test(row[3] ?? '')
          : /^нет\s*[—-]\s*\S/i.test(row[3] ?? '')),
      );
      if (!addressed) missing.push(`${step.file}:${step.symbol} ← ${address}`);
    }
  }
  if (missing.length === 0) return null;
  const bounded = missing.slice(0, 30);
  return `карта вызывающих не доведена: для каждого найденного места вызова укажи контракт и решение по колонке «Учтены в files_to_touch?»: ${bounded.join('; ')}${missing.length > bounded.length ? `; ещё ${missing.length - bounded.length}` : ''}`;
}

/** Require the approved plan to identify the exact requirement sources it was based on. */
export function planRequirementsProblem(c: StageContext): string | null {
  const plan = readArtifact(c.paths.plan);
  if (!plan.exists) return null;
  const intent = readArtifact(c.paths.intent);
  const clarification = readArtifact(c.paths.clarificationReport);
  const expected = resolvedRequirementsHash(intent.exists ? intent.text : '', clarification.exists ? clarification.text : '');
  const actual = readRequirementsHash(plan.text);
  return actual === expected
    ? null
    : `источники требований изменились после подготовки плана или в плане нет их отпечатка (ожидался SHA-256 ${expected}); вернись на этап 4 и получи новое одобрение`;
}

/** Готовая карта вызывающих для файлов, уже предложенных в `files_to_touch`. */
export function callersBlock(c: StageContext): string | null {
  const plan = readArtifact(c.paths.plan);
  if (!plan.exists) return null;
  const paths = extractFilesToTouch(plan.text);
  if (paths.length === 0) return null;
  const index = readTree(c.paths.projectRoot);
  const indexedPaths = new Set(paths);
  const rows: string[] = [];
  for (const file of index.files) {
    if (!indexedPaths.has(file.path) || file.kind === 'doc') continue;
    for (const symbol of file.symbols.filter((s) => s.exported)) {
      const callers = callersOf(index, symbol.name, file.path, index.files.length);
      if (callers.length === 0) continue;
      rows.push(
        `| \`${file.path}:${symbol.name}\` | ${callers.map((v) => `\`${v.path}:${v.line}${v.symbol === null ? '' : ` (${v.symbol})`}\``).join(', ')} |`,
      );
    }
  }
  if (rows.length === 0) {
    return [
      '## Вызывающие из индекса проекта',
      '',
      'Для экспортируемых символов в текущей карте вызывающие не найдены. Индекс ограничен распознанными исходниками; проверьте публичные потребители вне репозитория отдельно.',
    ].join('\n');
  }
  const text = [
    '## Вызывающие из индекса проекта',
    '',
    'Факты индекса для файлов files_to_touch. Это кандидаты; решение об изменении контракта и необходимости править вызовы остаётся в плане.',
    '',
    '| Символ | Вызывающие (все найденные места) |',
    '|---|---|',
    ...rows,
    ...(index.skipped.files > 0 ? ['', `Индекс пропустил файлов: ${index.skipped.files}; карта неполна.`] : []),
  ].join('\n');
  return capBytes(text, 24_000).text;
}

/**
 * Строка набора для гейта «Разбор последствий», если он включён и отчитывается на этапе 4.
 *
 * Одно место на оба потребителя (страж этапа 4 и перенос статуса в отчёт приёмки).
 * Пока условие было выписано дважды, статус гейта решался в двух местах и в два разных
 * момента — ровно то, от чего сторожит «единственная точка решения» (ревью).
 *
 * Этап строки уважается наравне с включённостью: гейт, перенесённый проектом на другой
 * этап, отчитывается там, и требовать секцию на четвёртом значило бы держать проверку,
 * о которой набор не просил.
 */
export function axesGateRow(gates: GatesFile | null): { name: string } | null {
  if (gates === null) return null;
  const row = gates.rows.find(
    (r) => gateKey(r.name) === gateKey('Разбор последствий') && r.enabled,
  );
  if (row === undefined || row.reportsAt !== 'этап 4') return null;
  return row;
}

/**
 * Проблемы разбора последствий (гейт «Разбор последствий», этап 4).
 *
 * Гейт выключен — проверять нечего: строка набора и есть решение проекта о том, ведётся
 * ли разбор. Пустой массив у включённого гейта означает «разбор доведён», а не «оси не
 * затронуты»: второе записывается исходом «н/п» с причиной, и это тоже решение.
 */
export function axisProblems(host: StageHost): string[] {
  const gates = host.gatesFile();
  if (gates === null || axesGateRow(gates) === null) return [];
  const plan = readArtifact(host.paths.plan);
  // Пустой массив означает «разбор доведён», поэтому отсутствие артефакта им быть не
  // может: молчание тут зеленило гейт по несуществующему плану.
  if (!plan.exists) return [`${host.paths.plan} не прочитан — разбор последствий проверять не по чему`];
  // Адресат исхода проверяется по РЕАЛЬНЫМ артефактам витка, иначе «claim-99» и
  // «гейт „Такого нет“» закрывают разбор за один ход (ревью).
  const intent = readArtifact(host.paths.intent);
  // Без задачи проверяются только имена гейтов — три адресата из четырёх не проверяются
  // вовсе, и гейт проходится словарём. Это отказ проверки, а не её зелёный исход.
  if (!intent.exists) {
    return [`${host.paths.intent} не прочитан — адресатов исходов проверять не по чему`];
  }
  // Пункты берём готовым `intentClaimLines()` — тем же разбором, которым живут выжимка
  // ретрая и добор клеймов: вторая копия «пробегись по строкам задачи» разошлась бы с
  // первой при первой же правке формы листа. Текст задачи ему передаётся, чтобы файл
  // не читался вторым разом внутри той же функции.
  const claimIds = [...host.intentClaimLines(intent.text).keys()];
  return planAxisProblems(plan.text, {
    claimIds,
    hasOpenQuestion: hasOpenQuestions(intent.text),
    hasInvariants: hasNamedInvariants(intent.text),
    enabledGates: gates.rows.filter((r) => r.enabled).map((r) => r.name),
  });
}

/**
 * Топ-ап осей плана: спросить модель ОДНИМ запросом по каждой оси, о которой секция
 * «Последствия шагов» ничего не сказала — см. докстринг `run/planAxisFill.ts`.
 *
 * Оси берутся из `unansweredAxes`, а не из `axisProblems()`: та ловит и СЕМАНТИЧЕСКИ
 * неверный ответ (ссылка на несуществующий claim/гейт) — топ-ап не переписывает решение,
 * которое модель уже приняла, пусть и сославшись на несуществующий адресат; такую строку
 * `finishGuard` укажет модели как прежде, а решать её человек должен видеть сам.
 */
export async function topUpAxes(host: StageHost, route: ResolvedRoute, system: string): Promise<void> {
  if (axesGateRow(host.gatesFile()) === null) return;
  const plan = readArtifact(host.paths.plan);
  if (!plan.exists) return;
  // План уже одобрен человеком (поле «Одобрение» в шапке) — топ-ап не переписывает
  // строки решения задним числом: одобрение принимается по прочитанному тексту, и
  // переписать таблицу осей после него значило бы подменить то, что человек одобрил.
  if (readDecision(plan.text, DECISION.approval).state === 'granted') return;
  const axes = unansweredAxes(plan.text);
  if (axes.length === 0) return;

  const intent = readArtifact(host.paths.intent);
  const claimIds = intent.exists ? [...host.intentClaimLines(intent.text).keys()] : [];
  const gates = host.gatesFile();
  const enabledGates = gates === null ? [] : gates.rows.filter((r) => r.enabled).map((r) => r.name);
  const exploration = readArtifact(host.paths.explorationReport);
  const axisSupportText = exploration.exists
    ? h2SectionRanges(exploration.text, /^опоры\s+осей$/i)
        .map((r) => exploration.text.slice(r.start, r.end).trim())
        .join('\n\n')
    : '';

  const limits = host.limits();
  // Форма добора — по ручке: пошаговый (одна степень свободы на вопрос) либо прежний
  // комбинированный; оба отдают один `PlanAxisFillResult` и пишутся одним путём ниже.
  const fill = route.planAxisFill === 'combined' ? fillPlanAxes : fillPlanAxesStepwise;
  const { answers, envFailure } = await fill({
    provider: createProvider(route.provider, route.providerDef, limits.chatTimeoutMs, host.trace('plan', 'planAxisFill')),
    model: route.model,
    params: route.params,
    system,
    axes,
    planText: plan.text,
    axisSupportText,
    claimIds,
    enabledGates,
    hasOpenQuestion: intent.exists ? hasOpenQuestions(intent.text) : false,
    hasInvariants: intent.exists ? hasNamedInvariants(intent.text) : false,
    signal: host.signal(),
    onProgress: (note) => host.emit({ type: 'warning', runId: host.id, stage: 'plan', message: `топ-ап осей: ${note}` }),
    onUsage: (usage) => host.accountOffPathUsage('plan', usage, route.providerDef.currency),
  });

  // Этап отменён, пока шёл добор: запрос одобрения после `Run.cancel` встал бы в уже
  // снятую очередь гейта и ждал бы человека вечно (code-review-all 2026-09-23).
  if (host.signal().aborted) return;
  if (answers.length > 0) {
    // Перечитываем план ПОСЛЕ `fillPlanAxes` — тот только что сделал долгий сетевой
    // запрос (минуты для локальных моделей), а `plan.text` снят ДО него. Строить запись
    // на устаревшей копии значило бы молча затереть ручную правку человека, внесённую,
    // пока модель отвечала (ревью) — та же причина, по которой одобрение плана тоже
    // проверяется заново, а не доверяет проверке в начале метода.
    const fresh = readArtifact(host.paths.plan);
    if (!fresh.exists || readDecision(fresh.text, DECISION.approval).state === 'granted') {
      if (envFailure !== null) throw new ProviderEnvError(envFailure);
      return;
    }
    const updated = applyAxisAnswers(fresh.text, answers);
    if (updated !== fresh.text) {
      // Запись — тем же путём, что у `applyRecords`: нормализованный `Write` через
      // политику и гейт одобрения. Второго места решения о доступе не появляется.
      const call: NormalizedCall = { kind: 'write', path: host.paths.plan, content: updated };
      const decision = await host.requestApproval({
        runId: host.id,
        stage: 'plan',
        requestId: host.syntheticRequestId('axis-fill'),
        toolName: 'Write',
        rawInput: { file_path: host.paths.plan, content: updated },
        call,
        ctx: host.policyContext('plan'),
      });
      if (decision.allowed) {
        const edited = (decision.updatedInput as Record<string, unknown> | null)?.['content'];
        writeArtifact(host.paths.plan, typeof edited === 'string' ? edited : updated);
        host.emit({
          type: 'warning',
          runId: host.id,
          stage: 'plan',
          message: `топ-ап осей: дописано ${answers.length} из ${axes.length}`,
        });
      }
    }
  }
  if (envFailure !== null) throw new ProviderEnvError(envFailure);
}

export const planStage: StageDef = {
  id: 'plan',
  skill: 'sdlc-plan',
  title: 'План витка',
  // `Bash` в списке нет: поле «База» пишет рантайм (`autofillPlan`, `git rev-parse HEAD`
  // мимо модели), а остальное — та же причина, что на этапе 1: план — это документ, а не
  // прогон команд. Разведка, которой нужно смотреть в дерево, идёт этапом раньше и своими
  // инструментами чтения. (Устаревший комментарий «Bash — для git rev-parse HEAD в поле
  // «База»» утверждал обратное — найдено ревью `stage-review-2026-09-18.md`, S7.)
  tools: ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'AskHuman', 'FinalizeArtifact', 'FillField'],
  subagents: [],
  produces: (c) => [c.paths.plan, c.paths.readiness, ...(isPreparationV2(c.paths) ? [c.paths.intent] : [])],
  requires: [
    {
      describe: 'отчёт разведки на месте (или мелкий контур)',
      artifact: (c) => c.paths.explorationReport,
      check: (c) =>
        isSmallContour(c) || artifactExists(c.paths.explorationReport)
          ? null
          : `нет файла ${c.paths.explorationReport}. На мелком контуре разведка не ` +
            `запускается — тогда пометь это в поле «Контур» задачи.`,
    },
    // Та же функция полноты, что у стража этапа 1 и входа в разведку (`intentFilled`): на
    // мелком контуре секцию «Что придётся тронуть» не заполняет никто, и требовать её здесь
    // значило бы блокировать план по файлу, который этап 1 честно закрыл.
    { ...intentFilled('задача заполнена без плейсхолдеров', true), check: (c) => intentFilled('задача заполнена', !isPreparationV2(c.paths)).check(c) },
    explorationPathsExist(),
    // И здесь тоже, не только на explore: мелкий контур пропускает разведку целиком
    // (`explore.skipIf`), и без этой строки его ветка `small ? 1 : 3` внутри проверки
    // была мертва — пустой лист доезжал до вердикта.
    claimsMinimum(),
    // Восьмое условие вердикта проверяется и на входе этапа 4: переписанная задача не
    // должна доехать до плана, а «уточнено с одобрения» — единственный законный путь.
    { ...intentSectionsIntact('задача не переписана внутри витка (снимок секций intent.md)'), check: (c) => isPreparationV2(c.paths) ? null : intentSectionsIntact('версия задачи').check(c) },
  ],
  // План здесь и создаётся, поэтому защищены только задача и набор гейтов.
  protectedArtifacts: (c) => [`${SDLC_DIR}/gates.md`, ...(isPreparationV2(c.paths) ? [] : [relOf(c, c.paths.intent)])],
  humanGate: { artifact: 'plan', label: DECISION.approval },
  skipIf: null,
};

export const planModule: StageModule = {
  def: planStage,
  runtimeFacts: [{ id: 'indexed-callers', purpose: 'вызывающие экспортируемых символов из файлов files_to_touch', freshness: 'live' }],
  formFillExecutor: true,
  leanDocTools: true,
  mechanicalJobs: (host) => {
    const date = new Date().toISOString().slice(0, 10);
    return [
      {
        path: host.paths.plan,
        fill: async (t) => {
          const head = await host.head();
          const intent = readArtifact(host.paths.intent);
          const clarification = readArtifact(host.paths.clarificationReport);
          const autofilled = autofillPlan(t, {
            title: host.slug,
            explorationDone: artifactExists(host.paths.explorationReport),
            clarificationDone: artifactExists(host.paths.clarificationReport),
            base: head.sha ?? head.why,
            requirementsHash: resolvedRequirementsHash(
              intent.exists ? intent.text : '',
              clarification.exists ? clarification.text : '',
            ),
          });
          // Засев files_to_touch (4.1, «П»-половина): модель решает по готовой строке
          // (оставить/исключить/добавить), а не составляет список с нуля. Идемпотентно —
          // см. докстринг `seedFilesToTouch`.
          const touch = intent.exists ? touchListEntries(intent.text) : [];
          const seeded = seedFilesToTouch(autofilled.text, touch);
          return { text: seeded.text, filled: autofilled.filled + seeded.seeded };
        },
      },
      { path: host.paths.readiness, fill: async (t) => autofillReadiness(t, { title: host.slug, date, run: 2 }) },
    ];
  },
  checksBranchOnEntry: true,
  begin: (host, route) => ({
    enterFacts: async () => {
      const ctx = host.ctx();
      const callers = callersBlock(ctx);
      const clarification = readArtifact(ctx.paths.clarificationReport);
      const resolutions = clarificationResolutionBlock(clarification.exists ? clarification.text : '', isPreparationV2(host.paths));
      return [callers, resolutions].filter((fact): fact is string => fact !== null);
    },
    // Снимка секций задачи может не быть (виток начат до его появления или с середины по
    // снимку артефактов) — тогда он снимается здесь, с предупреждением: с этого момента
    // задача под сверкой, а что было до — не проверено.
    afterStart: async () => {
      if (isPreparationV2(host.paths)) return;
      ensureIntentSnapshot(host, 'plan');
    },

    // Новая редакция плана — новое одобрение (`SDLC.md` → «Раскладка артефактов»): прежняя
    // одобренная редакция перед перезаписью переименовывается в `plan-v‹K›.md` КАК ЕСТЬ —
    // с подписью человека под той редакцией, которую он одобрял, — а свежий `plan.md`
    // раскладывается формой с пустым полем «Одобрение». До раскладки форм: иначе
    // существующий одобренный план остался бы «планом» и правился бы поверх подписи.
    beforeSeed: async () => {
      const plan = readArtifact(host.paths.plan);
      if (!plan.exists) return;
      if (readDecision(plan.text, DECISION.approval).state !== 'granted') return;
      let k = 1;
      while (artifactExists(host.paths.planArchive(k))) k += 1;
      renameSync(host.paths.plan, host.paths.planArchive(k));
      host.emit({
        type: 'warning',
        runId: host.id,
        stage: 'plan',
        message:
          `одобренная редакция плана переименована в ${host.paths.planArchive(k)} как есть; новый plan.md ` +
          'раскладывается формой — одобрение прежней редакции на него не переносится',
      });
    },

    // Топ-ап осей плана (`ModelDef.planAxisFill`): оси, о которых секция «Последствия
    // шагов» ничего не сказала, добираются узкими вопросами рантайма. До стража завершения
    // этапа — он увидит меньше проблем, если топ-ап уже закрыл часть строк.
    afterTurn: async (stagePrompt, signal) => {
      if (route.flow === 'loop' && route.planAxisFill !== false && !signal.aborted && !isPreparationV2(host.paths)) {
        await topUpAxes(host, route, stagePrompt.system);
      }
    },
    afterForm: async (_prompt, _def, _agents, hooks) => {
      if (isPreparationV2(host.paths) && !host.signal().aborted && readinessRun2(host.ctx()).ready &&
          filesToTouchProblem(host.ctx()) === null && planRequirementsProblem(host.ctx()) === null &&
          planClarificationProblem(host.ctx()) === null && planMapProblem(host.ctx()) === null && axisProblems(host).length === 0) {
        await reviewPreparation(host, hooks);
      }
    },
    outcomeProblem: () => isPreparationV2(host.paths) ? preparationReviewProblem(host.paths) : null,

    // Разбор последствий — тем же приёмом и по той же причине, что карта разведки:
    // находка нужна модели в её собственном ходу. Предусловием этапа 5 она пришла бы
    // после ухода планировщика, а дописывать исход за него стало бы некому — кроме
    // самого исполнителя, которому решение человека не принадлежит.
    finishProblem: () => {
      if (isPreparationV2(host.paths)) {
        const problem = requirementProblem(readArtifact(host.paths.intent).text);
        if (problem !== null) return problem;
        const plan = readArtifact(host.paths.plan);
        const hash = resolvedRequirementsHash(readArtifact(host.paths.intent).text, readArtifact(host.paths.clarificationReport).text);
        if (plan.exists && readRequirementsHash(plan.text) !== hash) {
          const without = plan.text.replace(/^- \*\*Требования \(SHA-256\):\*\*[^\n]*(?:\n|$)/gmu, '');
          host.writeAutofilled(host.paths.plan, addRequirementsHash(without, hash), []);
        }
      }
      const draft = readArtifact(host.paths.plan);
      if (draft.exists && readRequirementsHash(draft.text) === null) {
        const intent = readArtifact(host.paths.intent);
        const clarification = readArtifact(host.paths.clarificationReport);
        const hash = resolvedRequirementsHash(intent.exists ? intent.text : '', clarification.exists ? clarification.text : '');
        host.writeAutofilled(host.paths.plan, addRequirementsHash(draft.text, hash), []);
      }
      const readinessResult = readinessRun2(host.ctx());
      const readiness = readArtifact(host.paths.readiness);
      const runtimeChecklist = readiness.exists && hasRuntimeReadiness(readiness.text);
      if (runtimeChecklist) {
        const date = new Date().toISOString().slice(0, 10);
        const updated = autofillReadiness(readiness.text, {
          title: host.slug, date, run: 2, checks: readinessResult.checks,
          verdict: readinessResult.ready ? 'ready' : 'not',
        });
        if (updated.text !== readiness.text) host.writeAutofilled(host.paths.readiness, updated.text, []);
      }
      // Пустой files_to_touch — раньше axisProblems: без адресов правки разбор
      // последствий по осям тоже не может ссылаться на реальные пути, но само по
      // себе отсутствие files_to_touch — более фундаментальная и более дешёвая в
      // проверке находка (см. filesToTouchProblem).
      const filesProblem = filesToTouchProblem(host.ctx());
      if (filesProblem !== null) return filesProblem;
      const touchProblem = planTouchDiscrepancyProblem(host.ctx());
      if (touchProblem !== null) return touchProblem;
      const sampleProblem = planStepSampleTextProblem(host.ctx());
      if (sampleProblem !== null) return sampleProblem;
      const stepProblem = planStepsProblem(host.ctx());
      if (stepProblem !== null) return stepProblem;
      const mapProblem = planMapProblem(host.ctx());
      if (mapProblem !== null) return mapProblem;
      const requirementsProblem = planRequirementsProblem(host.ctx());
      if (requirementsProblem !== null) return requirementsProblem;
      const clarificationProblem = planClarificationProblem(host.ctx());
      if (clarificationProblem !== null) return clarificationProblem;
      const problems = axisProblems(host);
      if (problems.length === 0 && (!runtimeChecklist || readinessResult.ready)) return null;
      if (problems.length === 0) return `проверки готовности прогона 2 не пройдены: ${readinessResult.checks}`;
      return [
        'секция «Последствия шагов» плана не доведена:',
        ...problems.map((p) => `- ${p}`),
        // Подписи под принятым риском в форме НЕТ намеренно: риск принимается полем
        // «Одобрение» плана, а подписная колонка была бы вторым каналом решения,
        // которого у человека в этом файле нет. Требуя подпись, страж гнал модель
        // дописывать колонку, которой в шаблоне эталона не существует (ревью).
        'Исход — из закрытого словаря: claim-N, инвариант, гейт «имя», принятый риск ' +
          '(с причиной и сроком возврата), следующий виток либо «н/п — почему». Совет ' +
          'свободным текстом исходом не является: у него нет исполнителя.',
      ].join('\n');
    },
  }),
};
