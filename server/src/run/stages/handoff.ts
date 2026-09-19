/** Этап 7 — передача: определение этапа и проверка зелёного отчёта приёмки. */

import { statSync } from 'node:fs';
import { basename } from 'node:path';

import {
  DECISION,
  artifactExists,
  decisionFieldLines,
  decisionLineIndexes,
  decisionStateAt,
  hasPlaceholder,
  lineStarts,
  readArtifact,
  readField,
  replaceDecisionFieldAt,
} from '../../artifacts/artifact.ts';
import { h2SectionRanges } from '../../md/table.ts';
import { BULLET_RE } from '../../artifacts/planFiles.ts';
import type { ResolvedProfile } from '../../config/schema.ts';
import { publishPreconditionCheck } from '../../gates/builtin/index.ts';
import { gateKey } from '../../gates/gatesFile.ts';
import { currentBranch, isRepo, repoOrigin } from '../../gates/git.ts';
import { commitByRuntime } from '../commitByRuntime.ts';
import type { HandoffFacts } from '../formAutofill.ts';
import { autofillHandoff } from '../formAutofill.ts';
import { postmortemBlock } from '../postmortem.ts';
import { runNamedGate } from './chunk/evidence.ts';
import { relOf } from './preconditions.ts';
import type { StageContext, StageDef, StageHost, StageModule } from './types.ts';

/**
 * Единая валюта маршрутов профиля — для пост-виток отчёта на входе этапа 7. Смешанный
 * профиль честно отдаёт USD как было: выдумать общую валюту для рублёвого и долларового
 * маршрута нельзя.
 */
export function profileCurrency(profile: ResolvedProfile): string {
  const set = new Set(
    Object.values(profile.routes).map((r) => r.providerDef.currency ?? 'USD'),
  );
  return set.size === 1 ? [...set][0]! : 'USD';
}

/** Отчёт приёмки последней попытки говорит, что виток принят. */
function verificationPassed(c: StageContext): boolean {
  const report = readArtifact(c.paths.verificationReport(c.chunk, c.attempt));
  if (!report.exists) return false;
  // Markdown-жирность обязана прощаться: сама форма методологии пишет `- **passed:** true`
  // (templates/verification-report.template.md, секция «Вердикт») — прежний regex не
  // признавал КАНОНИЧЕСКИЙ зелёный отчёт зелёным, и handoff отказывался от передачи
  // ровно на первом же успешном витке. Якорь — НАЧАЛО строки (плюс маркер списка):
  // `passed: true`, процитированный в прозе отчёта («в шаблоне написано …»), не должен
  // открывать передачу непринятого витка.
  return /^\s*[-*>\s]*[*_]*passed[*_]*\s*[:=]\s*[*_]*\s*true/im.test(report.text);
}

export const handoffStage: StageDef = {
  id: 'handoff',
  skill: 'sdlc-handoff',
  title: 'Передача',
  tools: ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash', 'AskHuman', 'FinalizeArtifact', 'FillField'],
  subagents: [],
  produces: (c) => [c.paths.handoff],
  requires: [
    // Методология требует на входе вердикт passed=true и приёмку человека. Handoff
    // при этом пишется и при обрыве витка — но обрыв это осознанное решение оператора,
    // а не то, во что можно свалиться, дёрнув этап из любого состояния. Поэтому обрыв
    // разрешается явным флагом, а по умолчанию нужен зелёный отчёт приёмки.
    {
      describe: 'отчёт приёмки с passed=true (или явно объявленный обрыв витка)',
      artifact: (c) => c.paths.verificationReport(c.chunk, c.attempt),
      check: (c) => {
        if (verificationPassed(c)) return null;
        const report = c.paths.verificationReport(c.chunk, c.attempt);
        return artifactExists(report)
          ? `вердикт в ${report} не passed=true. Коммит из этого состояния методология ` +
              `запрещает: возврат на доработку или эскалация, но не передача. Чтобы ` +
              `оформить обрыв витка, запусти этап с флагом «обрыв».`
          : `нет отчёта приёмки ${report}. Передача без вердикта возможна только как ` +
              `обрыв витка — запусти этап с флагом «обрыв».`;
      },
    },
  ],
  // gates.md здесь править можно: методология велит дописывать сюда строку долга.
  protectedArtifacts: (c) => [relOf(c, c.paths.plan), relOf(c, c.paths.intent)],
  humanGate: { artifact: 'handoff', label: DECISION.accepted },
  skipIf: null,
};

/**
 * Дата последнего изменения набора гейтов — по mtime `.sdlc/gates.md`, не по содержимому:
 * набор не несёт собственной строки «когда изменён», а файловая система знает это точно.
 * `н/п — набора нет` — законный исход обрыва витка ДО того, как набор собран (`gatesFile`
 * снят из предусловий handoff ровно для этого случая, `Run.blockerDetails`).
 */
function gatesDateFact(gatesPath: string): string {
  try {
    return statSync(gatesPath).mtime.toISOString().slice(0, 10);
  } catch {
    return 'н/п — набора нет';
  }
}

/** «Имя репозитория или remote URL» шапки — origin, а без него имя каталога проекта. */
async function repoIdentity(projectRoot: string): Promise<string> {
  return (await repoOrigin(projectRoot)) ?? basename(projectRoot);
}

/**
 * «База» — из журнала ТЕКУЩЕГО chunk'а, а не текущий HEAD: к моменту автозаполнения
 * `commitByRuntime` (хук `afterStart`, выполняется раньше `mechanicalJobs`) уже мог
 * сдвинуть HEAD своим коммитом, и `host.head()` здесь дал бы значение, неотличимое от
 * поля `commit` — то же расхождение источников, которого избегает `autofillPlan`.
 */
function baseShaFromJournal(host: StageHost): string {
  const journal = readArtifact(host.paths.chunkJournal(host.chunk()));
  if (!journal.exists) return 'н/п — журнал chunk’а не найден';
  const field = readField(journal.text, 'База');
  return field === null || field.includes('‹') ? 'н/п — журнал ещё не заполнен' : field;
}

/**
 * Четыре подполя строки «Статус» гейта «Проверка предусловий публикации» (шапка handoff'а).
 * Статус — через `runNamedGate`: он единственный уважает выключение/долг строки набора,
 * а `публикация не проверялась` (⏭) не должна проверяться напрямую и сама.
 * Подполя — через `publishPreconditionCheck`, тот же факт, что использует BUILTIN-гейт,
 * но структурированный, а не пересказанный прозой `lastLine`.
 *
 * Подполя считаются ТОЛЬКО когда статус даёт сама builtin-реализация (строка набора без
 * команды в обратных кавычках). Если проект переопределил строку своей командой,
 * `runNamedGate` честно вернёт статус ЭТОЙ команды — а `publishPreconditionCheck` всё
 * равно посчитал бы branchOk/hasCommit/junk по СОВСЕМ ДРУГОЙ, встроенной логике, не имеющей
 * отношения к тому, что проверила чужая команда. Подстановка builtin-подполей поверх
 * чужого статуса раньше давала самопротиворечивую строку вида «Статус: ✅ · ветка: не
 * та» (ревью code-review-all, 2026-09-18) — у переопределённой строки структуры для
 * подполей просто нет, и честнее явно сказать это, чем угадать.
 */
/**
 * Строка «Проверка предусловий публикации» набора переопределена своей командой (не
 * встроенной реализацией). Вынесено чистой функцией отдельно от `publishGateLineFacts`
 * ради теста без реального прогона гейта.
 */
export function publishGateRowOverridden(gates: ReturnType<StageHost['gatesFile']>): boolean {
  const row = gates?.rows.find((r) => gateKey(r.name) === gateKey('Проверка предусловий публикации'));
  return row?.command !== null && row?.command !== undefined;
}

async function publishGateLineFacts(
  host: StageHost,
): Promise<{ status: string; branchOk: string; hasCommit: string; junk: string }> {
  const overridden = publishGateRowOverridden(host.gatesFile());
  const result = await runNamedGate(host, 'Проверка предусловий публикации', undefined, 'handoff');
  if (result === null || (result.status !== '✅' && result.status !== '❌')) {
    return { status: result?.status ?? '⏭', branchOk: 'н/п', hasCommit: 'н/п', junk: 'н/п' };
  }
  if (overridden) {
    const note = 'н/п — гейт переопределён командой набора';
    return { status: result.status, branchOk: note, hasCommit: note, junk: note };
  }
  const facts = await publishPreconditionCheck(host.projectRoot);
  if (facts === null) return { status: '⏭', branchOk: 'н/п', hasCommit: 'н/п', junk: 'н/п' };
  const branchOk = facts.problems.some((p) => p.startsWith('[protected-branch]')) ? 'не та' : 'та';
  const hasCommit = facts.problems.some((p) => p.startsWith('[nothing-to-publish]')) ? 'нет' : 'да';
  const junkProblem = facts.problems.find((p) => p.startsWith('[build-artifacts-committed]'));
  const junk = junkProblem === undefined ? 'нет' : junkProblem.replace('[build-artifacts-committed] ', '').replace(/\r?\n/g, '; ');
  return { status: result.status, branchOk, hasCommit, junk };
}

/**
 * Поле «Коммит» шапки — по факту РЕАЛЬНОГО вызова `commitByRuntime` этим входом
 * (`host.commitOutcome()`), а не по текущему HEAD независимо от него. Раньше поле считало
 * `head()` заново и совпадало с ожиданием только СЛУЧАЙНО, когда коммит состоялся — при
 * обрыве витка (`commitByRuntime` не вызывался вовсе) или неудачном коммите (нечего
 * коммитить, оператор отклонил, `git commit` упал) показывало правдоподобный, но чужой sha
 * вместо честного «н/п — причина» (ревью code-review-all, 2026-09-19).
 */
function commitFact(host: StageHost, head: { sha: string | null; why: string }): string {
  const outcome = host.commitOutcome();
  if (outcome === null) return 'н/п — виток оборван, локальный коммит не делался';
  if (!outcome.committed) return `н/п — ${outcome.note}`;
  return outcome.sha ?? head.sha ?? head.why;
}

async function handoffFacts(host: StageHost): Promise<HandoffFacts> {
  const gitRepo = await isRepo(host.projectRoot);
  const branch = gitRepo ? await currentBranch(host.projectRoot) : '';
  const [repo, head, publishGate] = await Promise.all([
    repoIdentity(host.projectRoot),
    host.head(),
    publishGateLineFacts(host),
  ]);
  return {
    title: host.slug,
    slug: host.slug,
    repo,
    branch: branch !== '' ? branch : 'н/п — не git-репозиторий',
    baseSha: baseShaFromJournal(host),
    commit: commitFact(host, head),
    gatesDate: gatesDateFact(host.paths.gates),
    chunk: host.chunk(),
    attempts: host.attempt(),
    verdict: verificationPassed(host.ctx()) ? 'passed' : 'aborted',
    published: 'нет',
    publishGate,
  };
}

const POSTPONED_SECTION_RE = /Отложено/i;

/**
 * Пункты «Отложено» отчёта по вопросам — пропущенные неблокирующие вопросы, которые
 * шаблон обязывает вести дальше витком («уходят следующему витку, а не исчезают»).
 * Строка-образец (плейсхолдер) и «нет отложенных» не возвращаются.
 */
export function postponedItems(clarificationText: string): string[] {
  const range = h2SectionRanges(clarificationText, POSTPONED_SECTION_RE)[0];
  if (range === undefined) return [];
  const section = clarificationText.slice(range.start, range.end);
  const out: string[] = [];
  for (const raw of section.split('\n')) {
    const m = BULLET_RE.exec(raw.trim());
    if (m === null) continue;
    const item = m[1]!.trim();
    if (item === '' || hasPlaceholder(item) || /^нет отложенных/i.test(item)) continue;
    out.push(item);
  }
  return out;
}

/**
 * Данные для «С чего начинать дальше» (7.6): «Уходит следующим chunk'ам» плана и
 * «Отложено» отчёта по вопросам — готовым списком, а не по памяти модели. Снимает
 * измеренный класс «handoff как changelog»: без исходных данных под рукой поле
 * реконструируется по остальным секциям витка и превращается в пересказ уже сделанного,
 * а не в адрес следующего шага.
 *
 * `null` — рассказывать нечего (оба источника пусты/недоступны): пустой блок в промпте
 * читался бы как «рантайм проверил и нашёл ничего», хотя проверять было не по чему.
 */
export function nextStepsBlock(host: StageHost): string | null {
  const plan = readArtifact(host.paths.plan);
  const carriedOver = plan.exists ? readField(plan.text, "Уходит следующим chunk'ам") : null;

  const clarification = readArtifact(host.paths.clarificationReport);
  const postponed = clarification.exists ? postponedItems(clarification.text) : [];

  if (carriedOver === null && postponed.length === 0) return null;

  const lines = ["## Данные для «С чего начинать дальше» (посчитано рантаймом)", ''];
  lines.push(
    carriedOver === null
      ? "- Уходит следующим chunk'ам (план): не заполнено"
      : `- Уходит следующим chunk'ам (план): ${carriedOver}`,
  );
  if (postponed.length === 0) {
    lines.push('- Отложено (отчёт по вопросам): нет отложенных');
  } else {
    lines.push('- Отложено (отчёт по вопросам):');
    for (const item of postponed) lines.push(`  - ${item}`);
  }
  return lines.join('\n');
}

const RECORD_SECTION_RE = /Запись о проскочившем дефекте/i;
const RECORD_H3_RE = /^###\s+.+$/gm;
const DEFAULT_WHO_APPROVED =
  '**(не утверждено — классификация агента по умолчанию)** — вопрос был пропущен или без ответа';

/**
 * Дефолт-подстановка «Кто утвердил» в записях о проскочившем дефекте (7.4, остаток).
 *
 * Срабатывает ТОЛЬКО когда у блока «### Запись N» нет больше ни одного незаполненного
 * места («‹…›») за вычетом самого поля «Кто утвердил» — то есть модель довела запись до
 * конца (класс, что проскочило, действие — всё заполнено) и оставила только это поле как
 * есть. Значение — ТРЕТЬЯ ветка, которую называет сам шаблон методологии («н/п / ‹имя› /
 * **(не утверждено…)** — вопрос был пропущен или без ответа»): рантайм не придумывает
 * исход, а честно фиксирует то, что и так следует из незаданного/неотвеченного вопроса,
 * вместо того чтобы держать поле `‹имя›` навсегда (страж завершения иначе не пропустит
 * готовую во всём остальном запись).
 *
 * Вызывается ПОСЛЕ хода модели (`afterTurn`), не до: у модели есть собственный ход, чтобы
 * спросить человека (`AskHuman`) и вписать настоящее имя, — рантайм лишь подстраховывает
 * запись, которую модель довела до конца, но не закрыла именно эту строку. Блок «Имя:
 * нет» (дефектов не было — законная форма шаблона, `н/п` во всех полях) не трогается: там
 * `н/п` — не пропущенный вопрос, а сама форма записи.
 *
 * Пишет только поле «Кто утвердил» — рантайм, не модель, тем же приёмом, что
 * `closeAnsweredQuestions`: политика `humanDecision.ts` касается только записей МОДЕЛИ и
 * здесь ни при чём. Значение — честный дефолт, а не имя, которое рантайм не вправе
 * сочинять: он никогда не пишет `granted`, только `declined`-текст самого шаблона.
 */
export function defaultUnapprovedRecords(handoffText: string): { text: string; repaired: number } {
  const h2 = h2SectionRanges(handoffText, RECORD_SECTION_RE)[0];
  if (h2 === undefined) return { text: handoffText, repaired: 0 };

  const section = handoffText.slice(h2.start, h2.end);
  const marks = [...section.matchAll(RECORD_H3_RE)].map((m) => h2.start + (m.index ?? 0));
  if (marks.length === 0) return { text: handoffText, repaired: 0 };

  let text = handoffText;
  let repaired = 0;
  // С КОНЦА — правка более позднего блока не сдвигает офсеты ещё не обработанных.
  for (let i = marks.length - 1; i >= 0; i--) {
    const start = marks[i]!;
    const end = i + 1 < marks.length ? marks[i + 1]! : h2.end;
    const block = text.slice(start, end);

    const name = readField(block, 'Имя');
    // `\b` по кириллице не работает (граница считается по ASCII, см. CLAUDE.md) — конец
    // слова проверяется явно пробелом/концом строки, тем же приёмом, что и везде в этом
    // рантайме.
    // Пунктуация после «нет» («нет.», «нет,») — законная человеческая/модельная форма,
    // не только пробел/тире/конец строки: без неё запись «Имя: нет.» проходила бы ВСЕ
    // защитные проверки как настоящий дефект и получала дефолт «Кто утвердил» вопреки
    // собственному инварианту этой функции (ревью code-review-all, 2026-09-19).
    if (name === null || /^нет(\s|[—–-]|[.,]|$)/i.test(name)) continue; // не начата либо «дефектов не было»

    const blockLines = block.split('\n');
    const whoLines = decisionLineIndexes(blockLines, DECISION.whoApproved);
    if (whoLines.length === 0) continue; // поля нет вовсе — не наш шаблон
    const whoLineIdx = whoLines[0]!;

    const blockStarts = lineStarts(block);
    const state = decisionStateAt(block, blockLines, blockStarts, whoLineIdx, DECISION.whoApproved);
    if (state.state !== 'placeholder') continue; // уже решено — своим именем или уже этим дефолтом

    const fieldRows = new Set(decisionFieldLines(block, blockLines, blockStarts, whoLineIdx));
    const withoutField = blockLines.filter((_l, idx) => !fieldRows.has(idx)).join('\n');
    if (hasPlaceholder(withoutField)) continue; // запись ещё не доведена — рано подставлять дефолт

    const repairedBlock = replaceDecisionFieldAt(
      block,
      blockLines,
      blockStarts,
      whoLineIdx,
      DECISION.whoApproved,
      DEFAULT_WHO_APPROVED,
    );
    if (repairedBlock === null || repairedBlock === block) continue;

    text = text.slice(0, start) + repairedBlock + text.slice(end);
    repaired++;
  }
  return { text, repaired };
}

export const handoffModule: StageModule = {
  def: handoffStage,
  formFillExecutor: false,
  leanDocTools: false,
  mechanicalJobs: (host: StageHost) => [
    {
      path: host.paths.handoff,
      fill: async (t) => autofillHandoff(t, await handoffFacts(host)),
    },
  ],
  checksBranchOnEntry: true,
  begin: (host) => ({
    // Пост-виток отчёт — вход этапа 7, тем же механизмом, что и итоги гейтов на этапе 6:
    // модель переносит числа в артефакт, но не сочиняет их.
    enterFacts: async () => {
      const blocks = [
        postmortemBlock(host.metrics(), profileCurrency(host.profile())),
        nextStepsBlock(host),
      ];
      return blocks.filter((b): b is string => b !== null);
    },

    // Локальный коммит — механика рантайма, не модели (`SDLC.md` → этап 7: «Делаю:
    // локальный коммит…»), и делается на ВХОДЕ, до хода модели: «Гейт «Проверка
    // предусловий публикации»» отчитывается фактом уже сделанного коммита, а не
    // обещанием. Обрыв витка коммита не делает: работа могла быть незакончена или
    // непроверена, и решение фиксировать её — не автоматическое.
    afterStart: async () => {
      // Сброс ДО решения об обрыве — иначе исход прошлого входа в этап (ретрай/рестарт
      // сервиса) утёк бы в `commitFact` этого входа, где коммит в этот раз не пытались.
      host.recordCommitOutcome(null);
      if (!verificationPassed(host.ctx())) return;
      const outcome = await commitByRuntime(host, 'passed');
      host.recordCommitOutcome(outcome);
      host.emit({
        type: 'warning',
        runId: host.id,
        stage: 'handoff',
        message: `локальный коммит рантайма: ${outcome.note}`,
      });
    },

    // Дефолт-подстановка «Кто утвердил» (7.4, остаток) — ПОСЛЕ хода модели, а не до: у
    // модели есть свой ход, чтобы спросить человека и вписать настоящее имя, рантайм
    // только подстраховывает запись, доведённую до конца во всём остальном.
    afterTurn: async () => {
      const a = readArtifact(host.paths.handoff);
      if (!a.exists) return;
      const { text, repaired } = defaultUnapprovedRecords(a.text);
      if (repaired === 0) return;
      host.writeAutofilled(host.paths.handoff, text, []);
      host.emit({
        type: 'warning',
        runId: host.id,
        stage: 'handoff',
        message:
          `рантайм подставил честный дефолт «Кто утвердил» в ${repaired} запис(ях) о ` +
          `дефекте — вопрос не был задан или остался без ответа`,
      });
    },
  }),
};
