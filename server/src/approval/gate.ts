/**
 * Гейт одобрений: держит промис, пока оператор не ответит.
 *
 * Два разных «нет» здесь не смешиваются:
 *
 *  - **отказ политики** — жёсткий. Оператор его снять не может, потому что политика это
 *    конструкция, а не рекомендация. Такой вызов даже не попадает в очередь на одобрение;
 *  - **отказ оператора** — решение человека, и оно фиксируется как таковое.
 *
 * Порядок здесь значим: **предпросмотр строится только после того, как политика сказала
 * «можно»**. Раньше он строился безусловно, и `Write ../../.ssh/id_rsa` отклонялся
 * политикой уже после того, как файл был прочитан целиком и разослан подписчикам шины —
 * запись не произошла, а содержимое приватного ключа утекло и осело в истории событий.
 */

import { AUTO_APPROVE_OFF } from '@sdlc-runner/shared';
import type { AutoApproveRules } from '@sdlc-runner/shared';

import { evaluate, writeTargetPaths, writeTargetsOf } from '../policy/index.ts';
import { normalizePlanPath } from '../policy/paths.ts';
import { normalize } from '../exec/normalize.ts';
import type {
  Decision,
  DiffPreview,
  NormalizedCall,
  PolicyContext,
  PolicyVerdict,
  StageId,
} from '@sdlc-runner/shared';
import { buildPreview } from './preview.ts';
import { symlinkEscape } from './symlink.ts';

export interface PendingApproval {
  runId: string;
  stage: StageId;
  requestId: string;
  /** Имя инструмента как его назвал исполнитель — нужно, чтобы перепроверить правку. */
  toolName: string;
  /**
   * Аргументы инструмента до нормализации.
   *
   * Правка оператора накладывается НА них, а не заменяет их целиком: интерфейс присылает
   * то, что человек изменил, и «полным входом» это считать нельзя.
   */
  rawInput: Record<string, unknown>;
  call: NormalizedCall;
  policy: PolicyVerdict;
  preview: DiffPreview | null;
  writeTargets: string[] | null;
  createdAt: number;
}

interface Waiting extends PendingApproval {
  /** Контекст политики этого вызова. Наружу не отдаётся — см. `visible()`. */
  ctx: PolicyContext;
  resolve: (d: Decision) => void;
}

/**
 * Что уходит наружу — в шину и в ответ `GET /api/runs/:id`.
 *
 * Раньше объект собирался через `{...args}`, и вместе с ним уезжал весь `PolicyContext`:
 * корень проекта, список файлов плана, защищённые артефакты, каталоги на чтение. В
 * контракте этих полей нет, читать их некому, а весить в буфере событий они продолжали.
 */
function visible(w: Waiting): PendingApproval {
  const { ctx: _ctx, resolve: _resolve, ...rest } = w;
  return rest;
}

export interface GateEvents {
  onPending: (p: PendingApproval) => void;
  /**
   * Прогон и этап передаются явно, а не выводятся из requestId: идентификатор вызова
   * приходит от исполнителя и о нашем прогоне ничего не знает.
   */
  onResolved: (
    info: { runId: string; stage: StageId; requestId: string },
    decision: Decision,
  ) => void;
}

/**
 * Вызовы, которые не ставятся в очередь одобрений.
 *
 * `read`/`glob`/`grep` — потому что их цена нулевая: сто подтверждений подряд превращают
 * гейт в кликанье. `ask_human` — потому что шаг человека у него СВОЙ: диалог вопросов.
 * Пока он стоял в очереди одобрений, интерфейс рисовал его как вопрос, ответ уходил в
 * другую очередь, а промис гейта не резолвился ничем — этап вставал намертво на первом
 * же вопросе человеку. Политика при этом проверяется до этой развилки, поэтому этап без
 * права `AskHuman` работающего инструмента всё равно не получает.
 */
const NO_HUMAN_STEP = new Set(['read', 'glob', 'grep', 'ask_human']);

/**
 * Столько раз подряд одна и та же команда обязана упасть, прежде чем гейт откажет
 * в повторе сам, не дожидаясь оператора.
 *
 * Наблюдение живого витка: рецензент прогнал ~10 одинаковых падающих `jar xf`/`javap` по
 * разным путям `.m2`, прерван вручную через reject. Три — это ещё «может, опечатка
 * в пути», четвёртый одинаковый — уже не диагностика, а зацикливание.
 */
const MAX_REPEAT_BASH_FAILURES = 3;

export class ApprovalGate {
  private readonly waiting = new Map<string, Waiting>();
  /** Правила автоодобрения по этапам. Отсутствие записи означает «спрашивать всегда». */
  private readonly autoRules = new Map<string, AutoApproveRules>();
  /**
   * Сколько раз подряд упала последняя команда bash этого прогона, и какая именно.
   *
   * По `runId`, не по `runId+stage`: зацикливание не спрашивает, сменился ли этап — та же
   * команда, повторённая после случайного перехода между этапами, всё ещё зацикливание.
   * Успех или другая команда сбрасывают счётчик — см. `recordBashResult`.
   */
  private readonly bashFailures = new Map<string, { command: string; count: number }>();
  private readonly events: GateEvents;

  constructor(events: GateEvents) {
    this.events = events;
  }

  private stageKey(runId: string, stage: StageId): string {
    return `${runId}:${stage}`;
  }

  /**
   * Ключ очереди включает прогон: идентификатор вызова выдаёт исполнитель, и он
   * уникален только внутри своей сессии. Без префикса одобрение из UI одного витка
   * закрывало вызов другого.
   */
  private key(runId: string, requestId: string): string {
    return `${runId}\u0000${requestId}`;
  }

  setAutoApprove(runId: string, stage: StageId, rules: AutoApproveRules): void {
    const k = this.stageKey(runId, stage);
    if (rules.planWrites || rules.bash || rules.rest) this.autoRules.set(k, rules);
    else this.autoRules.delete(k);
  }

  autoApproveRules(runId: string, stage: StageId): AutoApproveRules {
    return this.autoRules.get(this.stageKey(runId, stage)) ?? AUTO_APPROVE_OFF;
  }

  /**
   * Подпадает ли вызов под правило автоодобрения.
   *
   * Считается ПОСЛЕ политики и по нормализованному вызову: цели записи берутся из того же
   * `writeTargetsOf`, которым пользуется политика, — второй способ определить «куда пишет
   * вызов» разошёлся бы с первым, и разошёлся бы молча.
   */
  private matchesRule(
    call: NormalizedCall,
    ctx: PolicyContext,
    rules: AutoApproveRules,
  ): boolean {
    if (call.kind === 'bash') return rules.bash;

    // `writeTargetPaths` возвращает `null` для вызовов, которые вообще не пишут: такой
    // вызов «внутри плана» не бывает, и правило про правки к нему не относится.
    const targets = writeTargetPaths(call);
    const planFiles = ctx.planFiles;
    const insidePlan =
      targets !== null &&
      targets.length > 0 &&
      planFiles !== null &&
      targets.every((t) => planFiles.includes(normalizePlanPath(ctx.projectRoot, t)));

    // Правка целиком внутри плана — единственный случай, который оператор соглашался
    // пропускать осознанно. Хоть одна цель вне плана — это «остальное».
    if (insidePlan) return rules.planWrites;
    return rules.rest;
  }

  /** Автоодобрение действует на один этап и снимается при его завершении. */
  clearAutoApprove(runId: string, stage: StageId): void {
    this.autoRules.delete(this.stageKey(runId, stage));
  }

  list(): PendingApproval[] {
    return [...this.waiting.values()].map(visible);
  }

  /**
   * Основной путь вызова инструмента. Возвращает решение; политика считается первой и
   * обжалованию не подлежит.
   */
  async request(args: {
    runId: string;
    stage: StageId;
    requestId: string;
    toolName: string;
    rawInput: Record<string, unknown>;
    call: NormalizedCall;
    ctx: PolicyContext;
  }): Promise<Decision> {
    const info = { runId: args.runId, stage: args.stage, requestId: args.requestId };
    const writeTargets = writeTargetsOf(args.call);
    const base = { ...args, writeTargets, createdAt: Date.now() };

    // Одна и та же bash-команда упала уже `MAX_REPEAT_BASH_FAILURES` раз подряд — отказ
    // ЗДЕСЬ, до политики и до оператора: не находка политики (команда сама по себе
    // разрешена), а факт истории этого прогона, которого чистая `evaluate` знать не может.
    const call = args.call;
    const loop = call.kind === 'bash' ? this.bashFailures.get(args.runId) : undefined;
    if (loop !== undefined && call.kind === 'bash' && loop.command === call.command && loop.count >= MAX_REPEAT_BASH_FAILURES) {
      const policy: PolicyVerdict = {
        ok: false,
        policy: 'repeatFailure',
        reason:
          `эта команда уже упала ${loop.count} раз подряд без изменений — команда падает ` +
          `повторно, смени подход, а не повторяй тот же вызов`,
      };
      const decision: Decision = { allowed: false, reason: `[repeatFailure] ${policy.reason}`, by: 'policy' };
      this.events.onPending(visible({ ...base, policy, preview: null, resolve: () => {} }));
      this.events.onResolved(info, decision);
      return decision;
    }

    const policy = this.checkAll(args.call, args.ctx);
    if (!policy.ok) {
      const decision: Decision = {
        allowed: false,
        reason: `[${policy.policy}] ${policy.reason}`,
        by: 'policy',
      };
      // Предпросмотра здесь нет намеренно: отклонённый вызов не должен приводить к
      // чтению файла, ради которого он и был отклонён.
      this.events.onPending(visible({ ...base, policy, preview: null, resolve: () => {} }));
      this.events.onResolved(info, decision);
      return decision;
    }

    if (NO_HUMAN_STEP.has(args.call.kind)) {
      return { allowed: true, updatedInput: null, by: 'auto' };
    }

    const preview = buildPreview(args.call, args.ctx.projectRoot);

    if (this.matchesRule(args.call, args.ctx, this.autoApproveRules(args.runId, args.stage))) {
      const decision: Decision = { allowed: true, updatedInput: null, by: 'auto' };
      this.events.onPending(visible({ ...base, policy, preview, resolve: () => {} }));
      this.events.onResolved(info, decision);
      return decision;
    }

    return new Promise<Decision>((resolve) => {
      const pending: Waiting = { ...base, policy, preview, resolve };
      this.waiting.set(this.key(args.runId, args.requestId), pending);
      this.events.onPending(visible(pending));
    });
  }

  /**
   * Политика плюс проверка побега через symlink. Вторая требует диска и потому живёт вне
   * чистой политики, но отвечает на тот же вопрос и обязана считаться вместе с ней.
   *
   * Проверяются ВСЕ цели записи вызова, а не три захардкоженных вида. Пока список был
   * `write|edit|read`, запись через shell-редирект (`echo x > vendor/cache/keys`, где
   * `vendor/cache` — симлинк наружу) проходила лексически: политика видела путь внутри
   * проекта, а канонизировать его было некому.
   */
  private checkAll(call: NormalizedCall, ctx: PolicyContext): PolicyVerdict {
    const verdict = evaluate(call, ctx);
    if (!verdict.ok) return verdict;

    // Именно `writeTargetPaths`, а не отображаемый список: во втором к пути приклеено
    // «(переменная не развёрнута)», и такой строки на диске нет — проверка на симлинк
    // молча проходила по несуществующему файлу.
    const paths = [...(writeTargetPaths(call) ?? [])];
    if (call.kind === 'read') paths.push(call.path);

    for (const path of paths) {
      const escape = symlinkEscape(ctx.projectRoot, path, ctx.readOnlyRoots);
      if (escape !== null) return { ok: false, policy: 'pathScope', reason: escape };
    }
    return verdict;
  }

  /**
   * Ответ оператора. `false` — такого запроса нет (уже разрешён или устарел).
   *
   * Правка аргументов проходит политику ЗАНОВО. Иначе кнопка «править аргументы» была бы
   * дырой во всём поле безопасности: одобрив запись в файл плана и подменив путь на
   * `../../.ssh/id_rsa`, оператор исполнял бы её мимо PlanScope, PathScope и DenyList —
   * при том что шапка этого файла обещает обратное («отказ политики оператор снять не
   * может, потому что политика это конструкция, а не рекомендация»).
   */
  resolve(runId: string, requestId: string, decision: Decision): boolean {
    const k = this.key(runId, requestId);
    const w = this.waiting.get(k);
    if (w === undefined) return false;

    const effective = this.revalidate(w, decision);

    this.waiting.delete(k);
    this.events.onResolved({ runId: w.runId, stage: w.stage, requestId }, effective);
    w.resolve(effective);
    return true;
  }

  private revalidate(w: Waiting, decision: Decision): Decision {
    if (!decision.allowed || decision.updatedInput === null) return decision;

    // Правка НАКЛАДЫВАЕТСЯ на исходные аргументы, а не заменяет их. Интерфейс присылает
    // изменённые поля, и трактовка «это весь вход» была разрушительной: оператор, поправив
    // путь у `Edit`, отправлял исполнителю вызов без `new_string` — а `Write` без
    // `content` затирал файл пустотой. Наружу уходит уже слитый вход, потому что
    // исполнитель подставляет `updatedInput` дословно.
    const merged = { ...w.rawInput, ...(decision.updatedInput as Record<string, unknown>) };
    const edited = normalize(w.toolName, merged);
    const verdict = this.checkAll(edited, w.ctx);
    if (verdict.ok) return { ...decision, updatedInput: merged };

    return {
      allowed: false,
      reason:
        `правленые оператором аргументы не прошли политику [${verdict.policy}]: ` +
        `${verdict.reason}`,
      by: 'policy',
    };
  }

  /** Снимает все ожидающие запросы прогона — при отмене или обрыве этапа. */
  cancelRun(runId: string, reason: string): void {
    for (const [k, w] of [...this.waiting.entries()]) {
      if (w.runId !== runId) continue;
      this.waiting.delete(k);
      const decision: Decision = { allowed: false, reason, by: 'operator' };
      this.events.onResolved({ runId: w.runId, stage: w.stage, requestId: w.requestId }, decision);
      w.resolve(decision);
    }
    for (const k of [...this.autoRules.keys()]) {
      if (k.startsWith(`${runId}:`)) this.autoRules.delete(k);
    }
    this.bashFailures.delete(runId);
  }

  /**
   * Обновляет счётчик подряд идущих провалов bash-команды этого прогона.
   *
   * Зовёт `Run.onToolResult` — единственное место обоих флоу, которое узнаёт исход ПОСЛЕ
   * исполнения; `request()` выше решает ДО исполнения и исхода знать не может. Успех или
   * другая команда обнуляют счётчик: зацикливание — это одна и та же команда N раз подряд,
   * не N провалов вперемешку с другими попытками.
   */
  recordBashResult(runId: string, command: string, ok: boolean): void {
    if (ok) {
      this.bashFailures.delete(runId);
      return;
    }
    const prev = this.bashFailures.get(runId);
    const count = prev !== undefined && prev.command === command ? prev.count + 1 : 1;
    this.bashFailures.set(runId, { command, count });
  }
}
