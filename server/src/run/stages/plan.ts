/** Этап 4 — план витка: определение этапа и проверка `files_to_touch`. */

import type { NormalizedCall } from '@sdlc-runner/shared';

import { DECISION, artifactExists, hasNamedInvariants, readArtifact, readDecision, writeArtifact } from '../../artifacts/artifact.ts';
import { SDLC_DIR } from '../../artifacts/paths.ts';
import { planAxisProblems, unansweredAxes } from '../../artifacts/planAxes.ts';
import { extractFilesToTouch } from '../../artifacts/planFiles.ts';
import { applyAxisAnswers } from '../../artifacts/renderAxes.ts';
import type { ResolvedRoute } from '../../config/schema.ts';
import { gateKey } from '../../gates/gatesFile.ts';
import type { GatesFile } from '../../gates/gatesFile.ts';
import { h2SectionRanges } from '../../md/table.ts';
import { ProviderEnvError } from '../../provider/ChatProvider.ts';
import { createProvider } from '../../provider/registry.ts';
import { autofillPlan, autofillReadiness } from '../formAutofill.ts';
import { fillPlanAxes } from '../planAxisFill.ts';
import { explorationPathsExist } from './explore.ts';
import { claimsMinimum, filled, hasOpenQuestions, isSmallContour, relOf } from './preconditions.ts';
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
  const { answers, envFailure } = await fillPlanAxes({
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
  // Bash — для `git rev-parse HEAD` в поле «База».
  // Оболочки нет по той же причине, что на этапе 1: план — это документ, а не прогон
  // команд. Разведка, которой нужно смотреть в дерево, идёт этапом раньше и своими
  // инструментами чтения.
  tools: ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'AskHuman', 'FinalizeArtifact', 'FillField'],
  subagents: [],
  produces: (c) => [c.paths.plan, c.paths.readiness],
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
    filled('задача заполнена без плейсхолдеров', (c) => c.paths.intent),
    explorationPathsExist(),
    // И здесь тоже, не только на explore: мелкий контур пропускает разведку целиком
    // (`explore.skipIf`), и без этой строки его ветка `small ? 1 : 3` внутри проверки
    // была мертва — пустой лист доезжал до вердикта.
    claimsMinimum(),
  ],
  // План здесь и создаётся, поэтому защищены только задача и набор гейтов.
  protectedArtifacts: (c) => [`${SDLC_DIR}/gates.md`, relOf(c, c.paths.intent)],
  humanGate: { artifact: 'plan', label: DECISION.approval },
  skipIf: null,
};

export const planModule: StageModule = {
  def: planStage,
  formFillExecutor: true,
  leanDocTools: true,
  mechanicalJobs: (host) => {
    const date = new Date().toISOString().slice(0, 10);
    return [
      {
        path: host.paths.plan,
        fill: async (t) => {
          const head = await host.head();
          return autofillPlan(t, {
            title: host.slug,
            explorationDone: artifactExists(host.paths.explorationReport),
            clarificationDone: artifactExists(host.paths.clarificationReport),
            base: head.sha ?? head.why,
          });
        },
      },
      { path: host.paths.readiness, fill: async (t) => autofillReadiness(t, { title: host.slug, date, run: 2 }) },
    ];
  },
  checksBranchOnEntry: true,
};
