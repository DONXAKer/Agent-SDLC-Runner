/**
 * Автоответчик человека (шаг 2 ROADMAP.md).
 *
 * Заменитель ЧЕЛОВЕКА, а не политики: он подписывается на события уже построенных
 * `ApprovalGate`/`AskGate` и отвечает через их публичное API (`resolve`/`answer`), ровно
 * туда же, куда встаёт HTTP-оператор. Подкласс `ApprovalGate` не заводится — второе место
 * принятия решения о доступе конструкцией запрещено.
 *
 * Одна тонкость: `onPending` эмитится и для вызовов, которые гейт закрывает САМ (отказ
 * политики, `repeatFailure`, авто-правило) — там синхронно следом идёт `onResolved`, в
 * рамках того же синхронного вызова `request()`. Поэтому ответ автоответчика откладывается
 * на микротик, а уже закрытые гейтом запросы узнаются по тому, что `onResolved` успел
 * снять их из `mine` ДО того, как отложенный обработчик получил слово — не отдельным
 * разбором «а закрыл ли это гейт сам».
 *
 * `ApprovalGate`/`AskGate` принимают события ровно один раз, в конструкторе, и не дают
 * подписаться на них потом. `ApprovalBus`/`AskBus` ниже — тонкая фан-аут обвязка вокруг
 * штатного конструктора (не подкласс: `events`, который он передаёт внутрь, сам умеет
 * рассылать несколько подписчиков), которая и делает «подписаться после постройки»
 * возможным без второго решающего места.
 */

import { readFileSync } from 'node:fs';

import type { CallKind, Decision, Question, StageId } from '@sdlc-runner/shared';

import { AskGate, type PendingQuestions } from '../../server/src/approval/askGate.ts';
import { ApprovalGate, type PendingApproval } from '../../server/src/approval/gate.ts';

// ---------------------------------------------------------------------------
// Лог решений автоответчика
// ---------------------------------------------------------------------------

export interface OperatorDecisionLog {
  approvals: {
    stage: StageId;
    requestId: string;
    kind: CallKind;
    toolName: string;
    targets: string[];
    destructive: string | null;
    outcome: 'granted' | 'denied';
    why: string;
    waitedMs: number;
  }[];
  asks: {
    stage: StageId;
    questions: { id: string; question: string }[];
    answeredFrom: 'rule' | 'noise' | 'fallback';
    tag: string | null;
  }[];
  /** Запросы, закрытые самим гейтом: «человек» их не видел. */
  /**
   * Запросы, закрытые гейтом до автоответчика. `stage` обязателен: щуп «удержание границ»
   * судит ИЗМЕРЯЕМУЮ модель, а `verify` идёт контрольным маршрутом — без этапа отказы
   * рецензента приписывались измеряемой модели (замер 2026-09-05: 4 отказа из 6 у
   * `ministral-14b` сделал `claude-sdk:opus` на `verify`).
   */
  notMine: { stage: StageId; requestId: string; reason: 'policy' | 'auto' | 'repeat' }[];
}

export function emptyOperatorLog(): OperatorDecisionLog {
  return { approvals: [], asks: [], notMine: [] };
}

// ---------------------------------------------------------------------------
// Банк ответов человека (fixture/human.json)
// ---------------------------------------------------------------------------

interface AnswerRule {
  tag: string;
  match: string;
  answer: string[];
}

interface NoiseRule {
  tag: string;
  match: string;
}

export interface HumanScript {
  answers: {
    rules: AnswerRule[];
    noise: NoiseRule[];
    fallback: string[];
  };
  approvals: {
    destructiveOverwrite: 'allow' | 'deny';
    denyWritesTo: string[];
    denyScopeExtensionFor: string[];
    denyReason: string;
    default: 'allow' | 'deny';
  };
}

export class HumanScriptError extends Error {}

/** Читает и проверяет форму `fixture/human.json` — без этого опечатка в банке ответов
 * молчала бы до первого несовпавшего вопроса посреди платного прогона. */
export function readHumanScript(path: string): HumanScript {
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof raw !== 'object' || raw === null) throw new HumanScriptError(`${path}: ожидался объект`);
  const o = raw as Record<string, unknown>;

  const answers = o['answers'] as Record<string, unknown> | undefined;
  if (typeof answers !== 'object' || answers === null) throw new HumanScriptError(`${path}: нет поля answers`);
  const rules = answers['rules'];
  const noise = answers['noise'];
  const fallback = answers['fallback'];
  if (!Array.isArray(rules)) throw new HumanScriptError(`${path}: answers.rules не массив`);
  if (!Array.isArray(noise)) throw new HumanScriptError(`${path}: answers.noise не массив`);
  if (!Array.isArray(fallback)) throw new HumanScriptError(`${path}: answers.fallback не массив`);

  const approvals = o['approvals'] as Record<string, unknown> | undefined;
  if (typeof approvals !== 'object' || approvals === null) throw new HumanScriptError(`${path}: нет поля approvals`);
  const destructiveOverwrite = approvals['destructiveOverwrite'];
  const denyWritesTo = approvals['denyWritesTo'];
  const denyScopeExtensionFor = approvals['denyScopeExtensionFor'];
  const denyReason = approvals['denyReason'];
  const def = approvals['default'];
  if (destructiveOverwrite !== 'allow' && destructiveOverwrite !== 'deny') {
    throw new HumanScriptError(`${path}: approvals.destructiveOverwrite обязан быть allow|deny`);
  }
  if (!Array.isArray(denyWritesTo)) throw new HumanScriptError(`${path}: approvals.denyWritesTo не массив`);
  if (!Array.isArray(denyScopeExtensionFor)) {
    throw new HumanScriptError(`${path}: approvals.denyScopeExtensionFor не массив`);
  }
  if (typeof denyReason !== 'string') throw new HumanScriptError(`${path}: approvals.denyReason не строка`);
  if (def !== 'allow' && def !== 'deny') throw new HumanScriptError(`${path}: approvals.default обязан быть allow|deny`);

  return {
    answers: { rules, noise, fallback } as HumanScript['answers'],
    approvals: {
      destructiveOverwrite,
      denyWritesTo: denyWritesTo as string[],
      denyScopeExtensionFor: denyScopeExtensionFor as string[],
      denyReason,
      default: def,
    },
  };
}

// ---------------------------------------------------------------------------
// Фан-аут вокруг штатных конструкторов
// ---------------------------------------------------------------------------

type Unsubscribe = () => void;

/**
 * Обёртка вокруг `new ApprovalGate(...)`, построенной штатным конструктором. Сам гейт не
 * подменяется и не наследуется — фан-аут только рассылает события, которые гейт и так
 * обязан отдать РОВНО одному `events`-аргументу, нескольким подписчикам (коллектору и
 * автоответчику).
 */
export class ApprovalBus {
  readonly gate: ApprovalGate;
  private readonly pendingSubs = new Set<(p: PendingApproval) => void>();
  private readonly resolvedSubs = new Set<
    (info: { runId: string; stage: StageId; requestId: string }, decision: Decision) => void
  >();

  constructor() {
    this.gate = new ApprovalGate({
      onPending: (p) => {
        for (const fn of this.pendingSubs) fn(p);
      },
      onResolved: (info, decision) => {
        for (const fn of this.resolvedSubs) fn(info, decision);
      },
    });
  }

  onPending(fn: (p: PendingApproval) => void): Unsubscribe {
    this.pendingSubs.add(fn);
    return () => this.pendingSubs.delete(fn);
  }

  onResolved(
    fn: (info: { runId: string; stage: StageId; requestId: string }, decision: Decision) => void,
  ): Unsubscribe {
    this.resolvedSubs.add(fn);
    return () => this.resolvedSubs.delete(fn);
  }
}

/** Тот же фан-аут для вопросов человеку — см. `ApprovalBus`. */
export class AskBus {
  readonly gate: AskGate;
  private readonly pendingSubs = new Set<(p: PendingQuestions) => void>();
  private readonly answeredSubs = new Set<
    (info: { runId: string; stage: StageId; requestId: string }, answers: Record<string, string[]>) => void
  >();

  constructor() {
    this.gate = new AskGate({
      onPending: (p) => {
        for (const fn of this.pendingSubs) fn(p);
      },
      onAnswered: (info, answers) => {
        for (const fn of this.answeredSubs) fn(info, answers);
      },
    });
  }

  onPending(fn: (p: PendingQuestions) => void): Unsubscribe {
    this.pendingSubs.add(fn);
    return () => this.pendingSubs.delete(fn);
  }

  onAnswered(
    fn: (info: { runId: string; stage: StageId; requestId: string }, answers: Record<string, string[]>) => void,
  ): Unsubscribe {
    this.answeredSubs.add(fn);
    return () => this.answeredSubs.delete(fn);
  }
}

// ---------------------------------------------------------------------------
// Решение по одному одобрению
// ---------------------------------------------------------------------------

function closedByGateReason(decision: Decision): 'policy' | 'auto' | 'repeat' {
  if (decision.allowed && decision.by === 'auto') return 'auto';
  if (!decision.allowed && decision.by === 'policy' && /^\[repeatFailure\]/.test(decision.reason)) return 'repeat';
  return 'policy';
}

/**
 * Решение автоответчика по одному ожидающему одобрению.
 *
 * Порядок ловушек — из `fixture/human.json`: разрушающая перезапись, расширение scope на
 * запрещённый путь, запись в `denyWritesTo`, иначе — умолчание банка. `p.destructive` и
 * `p.writeTargets` берутся готовыми из `PendingApproval` — гейт их уже посчитал, и
 * пересчитывать их здесь вторым способом значило бы завести второе место, которое может
 * разойтись с первым.
 */
/**
 * Пути банка (`src/money.ts`) сравниваются подстрокой с путём вызова. Во флоу `sdk` на
 * Windows путь приходит абсолютным и с обратными слэшами (`D:\…\src\money.ts`), и без
 * приведения разделителей ловушка `denyWritesTo` не срабатывала вовсе: запись шла
 * «default → allow», щуп «удержание границ» зеленел без проверки. Флоу `loop` даёт
 * относительные пути с `/` — там совпадало и так, поэтому дефект жил незамеченным.
 */
function posixPath(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Регулярка банка. `\w` в JS — только ASCII даже под флагом `u`, а шаблоны банков написаны
 * по-русски (`запуск\w*\s+тест`, `обязател\w*\s+ли`): с буквальным `\w` они не совпадали ни
 * с одной русской формой, и вопросы уходили в fallback с ложным тегом — в 28 банках. Чинить
 * в одном месте: `\w` → буквы/цифры/подчёркивание любого алфавита. `\\w` (экранированный
 * обратный слэш перед w) не трогается.
 */
export function bankRegExp(source: string): RegExp {
  return new RegExp(source.replace(/(^|[^\\])\\w/g, '$1[\\p{L}\\p{N}_]'), 'iu');
}

function decideApproval(script: HumanScript, p: PendingApproval): { decision: Decision; why: string } {
  if (p.destructive !== null && script.approvals.destructiveOverwrite === 'deny') {
    return {
      decision: { allowed: false, reason: `разрушающая перезапись: ${p.destructive}`, by: 'operator' },
      why: `destructiveOverwrite → deny (${p.destructive})`,
    };
  }

  if (p.call.kind === 'request_scope_extension') {
    const path = posixPath(p.call.path);
    const denied = script.approvals.denyScopeExtensionFor.some((pat) => path.includes(posixPath(pat)));
    if (denied) {
      return {
        decision: { allowed: false, reason: script.approvals.denyReason, by: 'operator' },
        why: `denyScopeExtensionFor → deny (${p.call.path})`,
      };
    }
  }

  const targets = p.writeTargets ?? [];
  const deniedTarget = targets.find((t) => script.approvals.denyWritesTo.some((pat) => posixPath(t).includes(posixPath(pat))));
  if (deniedTarget !== undefined) {
    return {
      decision: { allowed: false, reason: script.approvals.denyReason, by: 'operator' },
      why: `denyWritesTo → deny (${deniedTarget})`,
    };
  }

  if (script.approvals.default === 'deny') {
    return {
      decision: { allowed: false, reason: script.approvals.denyReason, by: 'operator' },
      why: 'default → deny',
    };
  }
  return { decision: { allowed: true, updatedInput: null, by: 'operator' }, why: 'default → allow' };
}

// ---------------------------------------------------------------------------
// Решение по вопросу человеку
// ---------------------------------------------------------------------------

interface QuestionAnswer {
  source: 'rule' | 'noise' | 'fallback';
  tag: string | null;
  answer: string[];
}

function classifyQuestion(script: HumanScript, q: Question): QuestionAnswer {
  const text = `${q.question} ${q.header}`;
  for (const rule of script.answers.rules) {
    if (bankRegExp(rule.match).test(text)) return { source: 'rule', tag: rule.tag, answer: rule.answer };
  }
  for (const noise of script.answers.noise) {
    if (bankRegExp(noise.match).test(text)) {
      return { source: 'noise', tag: noise.tag, answer: script.answers.fallback };
    }
  }
  return { source: 'fallback', tag: null, answer: script.answers.fallback };
}

const SOURCE_RANK: Record<QuestionAnswer['source'], number> = { rule: 0, noise: 1, fallback: 2 };

// ---------------------------------------------------------------------------
// attachOperator
// ---------------------------------------------------------------------------

export interface AttachOperatorArgs {
  gate: ApprovalBus;
  askGate: AskBus;
  /** Прогон, за который отвечает этот автоответчик — фан-аут может обслуживать не только его. */
  runId: () => string;
  script: HumanScript;
  log: OperatorDecisionLog;
}

export function attachOperator(args: AttachOperatorArgs): { detach(): void } {
  const { gate, askGate, runId, script, log } = args;

  /** Одобрения, которые всё ещё «наши» — гейт их ещё не закрыл сам. */
  const mineApprovals = new Map<string, PendingApproval>();

  const offApprovalResolved = gate.onResolved((info, decision) => {
    if (info.runId !== runId()) return;
    const p = mineApprovals.get(info.requestId);
    if (p === undefined) return; // уже отвечено нами самими (см. ниже) — не второй раз
    mineApprovals.delete(info.requestId);
    log.notMine.push({ stage: p.stage, requestId: info.requestId, reason: closedByGateReason(decision) });
  });

  const offApprovalPending = gate.onPending((p) => {
    if (p.runId !== runId()) return;
    mineApprovals.set(p.requestId, p);
    queueMicrotask(() => {
      // Отсутствует — гейт уже закрыл запрос сам между `onPending` и этим тиком, и
      // `offApprovalResolved` выше уже записал его в `notMine`.
      if (!mineApprovals.has(p.requestId)) return;
      mineApprovals.delete(p.requestId);

      const { decision, why } = decideApproval(script, p);
      log.approvals.push({
        stage: p.stage,
        requestId: p.requestId,
        kind: p.call.kind,
        toolName: p.toolName,
        targets: p.writeTargets ?? [],
        destructive: p.destructive,
        outcome: decision.allowed ? 'granted' : 'denied',
        why,
        waitedMs: Date.now() - p.createdAt,
      });
      gate.gate.resolve(p.runId, p.requestId, decision);
    });
  });

  const offAskPending = askGate.onPending((p) => {
    if (p.runId !== runId()) return;
    queueMicrotask(() => {
      const answers: Record<string, string[]> = {};
      let best: QuestionAnswer = { source: 'fallback', tag: null, answer: script.answers.fallback };
      for (const q of p.questions) {
        const classified = classifyQuestion(script, q);
        answers[q.id] = classified.answer;
        if (SOURCE_RANK[classified.source] < SOURCE_RANK[best.source]) best = classified;
      }
      log.asks.push({
        stage: p.stage,
        questions: p.questions.map((q) => ({ id: q.id, question: q.question })),
        answeredFrom: best.source,
        tag: best.tag,
      });
      askGate.gate.answer(p.runId, p.requestId, answers);
    });
  });

  return {
    detach(): void {
      offApprovalPending();
      offApprovalResolved();
      offAskPending();
    },
  };
}
