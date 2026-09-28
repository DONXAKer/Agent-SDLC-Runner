/**
 * Этап 5 — chunk: определение этапа и механика журнала. Улики попытки —
 * `chunk/evidence.ts`, режим по шагам плана — `chunk/steps.ts`, восстановление номеров
 * chunk'а и попытки — `chunk/restore.ts`.
 */

import { DECISION, readArtifact, writeArtifact } from '../../../artifacts/artifact.ts';
import { attemptDiff } from '../../../gates/git.ts';
import { preflightGateBlockers } from '../../../gates/preflight.ts';
import { ensureSandboxFor } from '../../../sandbox/registry.ts';
import { checkJournalClaimsVsBash } from '../../../verdict/honesty.ts';
import { approvedPlanDate, autofillChunkJournal } from '../../journalAutofill.ts';
import { attemptJudgedInLog, readRunVerdict } from '../../verdictStore.ts';
import { RUNTIME_PROTECTED, granted, intentSectionsIntact, readinessReady } from '../preconditions.ts';
import { planMapProblem } from '../plan.ts';
import { attemptHadBash, ensureBaseline, recordEvidence } from './evidence.ts';
import type { SeededArtifact, StageDef, StageHost, StageModule } from '../types.ts';
import type { TreeChange } from '../../evidence.ts';

export const chunkStage: StageDef = {
  id: 'chunk',
  skill: 'sdlc-chunk',
  title: 'Chunk',
  tools: [
    'Read',
    'Glob',
    'Grep',
    'Write',
    'Edit',
    'Bash',
    'Task',
    'AskHuman',
    'FinalizeArtifact',
    'FillField',
    'RequestScopeExtension',
  ],
  // Точечная разведка места правки — read-only по построению.
  subagents: ['sdlc-locator'],
  // Патча и записи о тестах здесь НЕТ намеренно: их производит рантайм из фактического
  // дерева и фактического прогона (`run/evidence.ts`), а не исполнитель этапа. Пока они
  // стояли в этом списке, страж завершения требовал их от модели — то есть просил
  // составить улику о собственной работе, что она и делала: «PASS ✓» без единого запуска
  // тестов (`docs/model-runs.md`, этап 5). Проверка «этап что-то сделал» держится теперь
  // на журнале chunk'а и на непустом патче, а не на наличии файлов, которые кладём мы сами.
  produces: (c) => [c.paths.chunkJournal(c.chunk)],
  requires: [
    // Без заполненного поля одобрения chunk не начинается — так требует методология,
    // и проверяется именно поле в файле, а не память диалога.
    granted('план одобрен человеком', (c) => c.paths.plan, DECISION.approval),
    {
      describe: 'адреса явных шагов плана совпадают с текущим деревом',
      artifact: (c) => c.paths.plan,
      check: (c) => planMapProblem(c),
    },
    // Задача переписана после одобрения плана — дешевле узнать здесь, чем сжечь попытку на
    // этапе 6 (`SDLC.md` требует сверку на этапах 4 и 6; вход chunk — та же сверка раньше).
    intentSectionsIntact('задача не переписана внутри витка (снимок секций intent.md)'),
    // Прогон 2 готовности пишется вместе с планом (этап 4): его вердикт «не готова»
    // обязан остановить виток ДО первой правки кода, а не только лежать в файле.
    readinessReady('проверка готовности не отвергла задачу (прогон 2)', 2, false),
    // Попытка, уже проверенная вердиктом, заново не прогоняется: chunk по её номеру
    // перезаписал бы улики проверенной попытки (патч, запись о тестах), а вердикт K остался
    // бы от старого патча — зелёный открыл бы handoff с коммитом непроверенного дерева.
    // Новая работа — новая попытка (code-review-all 2026-09-23).
    {
      describe: 'текущая попытка ещё не проверена вердиктом',
      check: (c) => {
        const verdict = readRunVerdict(c.paths, c.chunk, c.attempt);
        if (verdict === null) {
          // Виток, начатый до подписанного вердикта: факт проверки — в журнале итераций.
          // «Принята» по нему не решается, но улики проверенной попытки он бережёт.
          return attemptJudgedInLog(c.paths, c.chunk, c.attempt)
            ? `попытка ${c.attempt} уже проверялась (iterations.md), но вердикта рантайма по ней ` +
                'нет — повтори verify, чтобы chunk не перезаписал её улики'
            : null;
        }
        // Красный из-за окружения номер попытки не занимает (`SDLC.md`): после починки
        // среды тот же K прогоняется заново — улики этой попытки по построению говорили
        // лишь «инструмента нет», беречь там нечего.
        if (!verdict.passed && verdict.action === 'blocked_env') return null;
        return verdict.passed
          ? `попытка ${c.attempt} уже принята вердиктом этапа 6 — дальше передача (handoff) ` +
              'или следующий chunk; chunk по той же попытке перезаписал бы проверенные улики'
          : `попытка ${c.attempt} уже отвергнута вердиктом этапа 6 — нажми «Новая попытка», ` +
              'чтобы chunk не перезаписал её улики (или повтори verify, если красное — от среды)';
      },
    },
  ],
  protectedArtifacts: RUNTIME_PROTECTED,
  humanGate: { artifact: 'journal', label: DECISION.confirmed },
  skipIf: null,
  evidence: (c) => [c.paths.chunkDiff(c.chunk, c.attempt), c.paths.chunkTests(c.chunk, c.attempt), c.paths.chunkEvidence(c.chunk, c.attempt)],
};

export const chunkModule: StageModule = {
  def: chunkStage,
  runtimeFacts: [{ id: 'carry-forward', purpose: 'диагнозы и результаты гейтов предыдущей попытки для корректирующей работы', freshness: 'attempt' }],
  formFillExecutor: false,
  leanDocTools: false,
  checksBranchOnEntry: true,
  // Проактивное закрытие готового этапа — не на chunk: журнал попытки может стать готовым
  // раньше кода, и раннее закрытие обрубило бы дописывание правок в дереве.
  closeOnFinalizeReady: false,
  begin: (host, route) => {
    /** Рабочее дерево до этапа — база «дерево не изменилось» для улик попытки. */
    let diffBefore = '';
    /** Живой геттер принятых записей — тот же, что уходит в `progressSignal` ниже. */
    let acceptedWrites: (() => number) | null = null;
    return {
    // Снимок рабочего дерева ДО этапа: «дерево не изменилось» обязано считаться против
    // него, а не против HEAD. Коммита до этапа 7 не бывает, поэтому правки прошлой попытки
    // и прошлого chunk'а остаются в дереве, и сравнение с HEAD объявляло бы результативной
    // любую попытку после первой удачной.
    // Снимается ТЕМ ЖЕ генератором, что и патч попытки (`attemptDiff`, от базы плана):
    // сравнение двух патчей разных генераторов давало «дерево изменилось» на нетронутом
    // дереве из-за одной разницы в контексте.
    // Повтор chunk'а на той же K после `blocked_env` (та же попытка — `SDLC.md`) — новая
    // работа: вердикт, итоги гейтов и лента прошлого прогона попытке не принадлежат, иначе
    // `verdictCountedFor` считал бы её уже учтённой и строка в iterations.md не писалась (ревью).
    resetOnEnter: () => {
      if (readRunVerdict(host.paths, host.chunk(), host.attempt())?.action === 'blocked_env') host.resetAttemptState();
    },

    // «Попытка не начинается, пока набор неисполним» (`SDLC.md` → этап 5): команды
    // включённых гейтов этапа 6 проверяются на исполнимость ДО первой правки. Неисполнимая
    // — `blocked_env` до попытки, а не после полного круга реализации; попытка не тратится.
    // Песочница поднимается ДО пробы: у проекта с тулчейном в docker PATH хоста пуст, и
    // preflight по нему давал бы постоянный ложный блок (ревью).
    entryBlocker: async () => {
      const gates = host.gatesFile();
      if (gates === null) return null;
      try {
        await ensureSandboxFor(host.projectRoot, host.projectName);
      } catch (e) {
        host.emit({ type: 'warning', runId: host.id, stage: 'chunk', message: `песочница для preflight не поднялась: ${(e as Error).message}` });
      }
      const blockers = await preflightGateBlockers(gates, host.projectRoot);
      return blockers.length > 0 ? blockers.join('\n') : null;
    },

    beforeSeed: async () => {
      try {
        diffBefore = await attemptDiff(host.projectRoot, {
          baseSha: (await host.baseSha()).sha,
          signal: host.aborterSignal(),
        });
      } catch (e) {
        diffBefore = '';
        host.emit({
          type: 'warning',
          runId: host.id,
          stage: 'chunk',
          message: `снимок дерева до этапа не снят: ${(e as Error).message} — «дерево не изменилось» будет считаться от пустого патча`,
        });
      }
    },

    // Дозаполнение журнала chunk'а по полям (`ModelDef.formFill` у модели этапа 5):
    // серия r5 показала конструкционный провал — модель с идеальным кодом 7 прогонов
    // подряд не закрывала этап, дочищая журнал инструментами до конца лимита ходов.
    // Содержательные поля добираются per-field completion'ами тем же FormFillExecutor,
    // запись идёт через тот же гейт; этап закрывается ТОЛЬКО если исполнитель упал
    // именно на оформлении и после дозаполнения на диске всё на месте.
    formFinish: (result) => {
      // В режиме по шагам (`stepFill`) журнал chunk'а исполнитель не пишет по построению:
      // дозаполнение по полям идёт с отчётом о шагах во входе — иначе поля «что сделано»
      // заполнялись бы по памяти, которой у режима нет. Но только если хоть один шаг дал
      // правку: журнал этапа, в котором не записано ничего, не стоит двенадцати запросов —
      // он всё равно красный по дереву.
      const stepMode = route.stepFill;
      const stepProduced = stepMode && /применено [1-9]/.test(result.note);
      // Отчёт о шагах — артефакт попытки: причина красного шага иначе остаётся только в
      // консоли, и разбор прогона восстанавливает её по дереву (bench, stepfill-v2).
      if (stepMode && result.finalText !== '') {
        writeArtifact(host.paths.chunkSteps(host.chunk(), host.attempt()), `${result.finalText}\n`);
      }
      return {
        path: host.paths.chunkJournal(host.chunk()),
        forced: stepProduced,
        // Отчёт о шагах — второй блок промпта дозаполнения, которого нет в промпте из
        // `prompt_prepared`: как и блок рецензента, он факт рантайма, а не правка за спиной
        // оператора.
        extraBlock: stepProduced && result.finalText !== '' ? result.finalText : null,
        // `notDone` на chunk смотрит только журнал, и заполненный дозаполнением журнал
        // переворачивал бы в ok этап, упавший на лимите ходов с нетронутым кодом.
        requireCodeChange: true,
        // Правка кода — и по дереву, а не только по принятым Write/Edit: код правят и через
        // Bash и MCP-запись, и такой этап, упавший на оформлении при изменённом дереве,
        // оставался красным.
        treeChanged: async () =>
          (await attemptDiff(host.projectRoot, {
            baseSha: (await host.baseSha()).sha,
            signal: host.aborterSignal(),
          })) !== diffBefore,
      };
    },

    // Свидетельства попытки — патч и запись о тестах — производит рантайм, перезаписывая
    // то, что записал агент. Иначе вход этапа 6 остаётся рассказом исполнителя о самом
    // себе; замер поймал ровно этот случай (см. `evidence.ts`).
    evidence: async () => {
      // Модель исполнителя — факт рантайма (маршрут профиля), а не самоотчёт: этап 6
      // сверяет её с моделью рецензента, и доказанным превосходство становится только так.
      host.chunkState.tree = await recordEvidence(host, diffBefore, route.modelId);

      // Честность доказательств: журнал утверждает «тесты прогнаны и прошли» — в ленте
      // обязан быть успешный bash-вызов команды тестов. Расхождение раньше было видно
      // только в отчёте бенчмарка после прогона; оператор витка обязан видеть его здесь,
      // до вердикта (порт щупа `bench/src/honesty.ts`).
      const journal = readArtifact(host.paths.chunkJournal(host.chunk()));
      if (journal.exists) {
        const honesty = checkJournalClaimsVsBash(
          journal.text,
          host.attemptToolEvents(),
          host.attemptObservedFromStart(),
        );
        if (honesty.ok === false) {
          host.emit({
            type: 'warning',
            runId: host.id,
            stage: 'chunk',
            message: `честность журнала: ${honesty.detail}`,
          });
        }
      }
    },

    // Пустое дерево после этапа 5 — самостоятельный провал, наравне с незаполненным
    // артефактом: свидетельства теперь кладёт рантайм, то есть «файлы на месте» перестало
    // быть признаком сделанной работы. `unknown` роняет этап по той же причине — состояние
    // дерева неизвестно, и считать его успехом значит зеленеть на непроверенном.
    outcomeProblem: (result) =>
      result.ok && host.chunkState.tree !== 'changed'
        ? host.chunkState.tree === 'empty'
          ? 'этап закончился, но дерево не изменилось: правки не было'
          : 'этап закончился, но состояние дерева неизвестно: свидетельства попытки не записаны'
        : null,

    // На этапе 5 прогресс — принятые записи в дерево: модель, повторившая вызов
    // рядом с делом, не должна терять уже записанный код.
    progress: (getWrites) => {
      acceptedWrites = getWrites;
      return {
        progressSignal: getWrites,
        // Без императива «Edit»: на задаче, где требуемое уже сделано, правка не
        // нужна вовсе, и совет по умолчанию толкал модель портить готовый код.
        progressHint:
          'если правка кода нужна — делай её сейчас инструментом Edit; если требуемое ' +
          'уже есть в коде — зафиксируй это в журнале и заверши этап.',
      };
    },

    // Модель пытается завершить ход, а дерево ещё не тронуто ни Write/Edit, ни Bash —
    // напоминание ДО провала, а не только `outcomeProblem` постфактум (серия local6,
    // 2026-09-24: `rename-field`, 18 ходов на разведку/чтения, ни одной правки, этап
    // упал молча). `finishGuard` (`Run.ts`) даёт до `FINISH_REMINDERS` шансов исправиться
    // в том же ходу — дешевле, чем сжечь весь лимит ходов и упасть на `outcomeProblem`.
    finishProblem: () => {
      if ((acceptedWrites?.() ?? 0) > 0) return null;
      if (attemptHadBash(host.attemptToolEvents())) return null;
      return (
        'ход завершён, но правки кода нет — ни одной принятой записи в дерево, ни ' +
        'успешного Bash-вызова за эту попытку. Если правка нужна — сделай её инструментом ' +
        'Edit/Write; если требуемое уже есть в коде — так и запиши в журнале, но дерево ' +
        'этапа 5 не может остаться пустым.'
      );
    },

    afterStart: () => ensureBaseline(host),

    // Диагноз прошлой попытки — вход повторного chunk'а. Без него ретрай уходил тем же
    // промптом, что и первая попытка: причины красного посчитаны, но до исполнителя не
    // доезжали, и он заново угадывал, что именно не сошлось.
    enterFacts: async () => {
      const carried = host.carryForward();
      return carried === null ? [] : [carried];
    },

    autofill: (seeded) => autofillJournal(host, seeded),
    };
  },
};

/**
 * Механические поля журнала chunk'а (номер, base_sha, бюджет попыток, даты) заполняет
 * рантайм ДО модели: замер серии r2 показал, что слабая модель с идеальным кодом
 * сжигает лимит ходов ровно на этих полях. Снимок после подстановки уходит в
 * `SeededArtifact.snapshot` — страж «бланк байт-в-байт» сравнивает с ним, и этап,
 * не сделавший ничего, по-прежнему виден.
 *
 * Заполняет механические поля журнала chunk'а фактами рантайма — см. `journalAutofill.ts`.
 *
 * Идёт и на попытке K>1 (журнал уже существует и посеян не в этот раз): подстановка
 * идемпотентна, а незаполненные механические поля с прошлой попытки не должны съедать
 * ходы и этой. Снимок после подстановки кладётся в `SeededArtifact.snapshot`, чтобы
 * страж «бланк байт-в-байт» не ослеп от нашей же записи.
 */
export async function autofillJournal(host: StageHost, seeded: SeededArtifact[]): Promise<void> {
  const path = host.paths.chunkJournal(host.chunk());
  const journal = readArtifact(path);
  if (!journal.exists || journal.placeholders === 0) return;

  // База журнала — та же, от которой снимается патч попытки (`host.baseSha`: поле «База»
  // плана, затем HEAD): база одного витка обязана читаться во всех артефактах одинаково.
  const baseSha = (await host.baseSha()).sha;

  // Дата одобрения плана — только из фактического решения в plan.md: сочинять дату
  // решения человека нельзя, не извлеклась — поле остаётся плейсхолдером.
  const plan = readArtifact(host.paths.plan);
  const planApprovedOn = plan.exists ? approvedPlanDate(plan.text) : null;

  const { text, filled } = autofillChunkJournal(journal.text, {
    chunk: host.chunk(),
    slug: host.slug,
    date: new Date().toISOString().slice(0, 10),
    baseSha,
    attemptBudget: host.attemptBudget(),
    planApprovedOn,
  });
  if (filled === 0) return;

  host.writeAutofilled(path, text, seeded);
  host.emit({
    type: 'warning',
    runId: host.id,
    stage: 'chunk',
    message:
      `рантайм заполнил механические поля журнала (${filled}): номер, base_sha, бюджет, ` +
      'даты — модели остались содержательные',
  });
}

/** Состояние этапа 5 между вызовами. Владелец — виток (`Run.state.chunk`). */
export class ChunkState {
  /**
   * Что стало с деревом за последнюю попытку этапа 5.
   *
   * Три значения, а не булево: «не знаем» (запись улик упала) обязано отличаться от
   * «правки были», иначе попытка с неизвестным состоянием дерева проходит как нормальная —
   * ровно та дыра, ради закрытия которой улики и отобраны у агента.
   */
  tree: TreeChange = 'unknown';
}
