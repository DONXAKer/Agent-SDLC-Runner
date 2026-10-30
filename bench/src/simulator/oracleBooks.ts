/**
 * Книги ответов оракула — по одной на задачу стенда.
 *
 * Книга знает ВЕРНЫЙ ответ на каждое решение конвейера guided v5: поля бланков, пункты
 * приёмки, исследование файлов, карточки плана, типизированные операции chunk, статусы
 * ревью. Ответы написаны по тексту задачи и исходникам фикстуры — тому же, что видит
 * модель; в скрытые тесты книга не смотрит.
 *
 * Книга подстраивается под СХЕМУ ответа, а не под текст подсказки: перечни допустимых
 * файлов, символов, claim'ов и evidenceId берутся из переданной схемы, строки запроса — из
 * текста задачи. Так книга остаётся верной при правке формулировок рантайма и ловит именно
 * расхождения контракта, а не стиля.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findSymbols } from '../../../server/src/exec/symbolOps.ts';
import type { Expression, Parameter, Statement } from '../../../server/src/exec/implementationIr.ts';

const BENCH_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface OracleChunkInput {
  input: any;
  schema: unknown;
  evidenceIds: string[];
  boundFile: string | null;
  boundSymbol: string | null;
}

export interface OracleBook {
  formField(key: string, input: any, property: unknown): string | null;
  fieldItems(input: any): string[];
  preparationClaims(schema: any, input: any): unknown;
  reviewScenarios(): unknown[];
  claim(input: any): unknown;
  failureDiagnosis(input: any, schema: unknown): unknown;
  fileResearch(input: any): unknown;
  questionResolution(input: any, schema: any, askedHuman: number): unknown;
  planOutline(input: any, schema: any): unknown;
  planCard(input: any, schema: any): unknown;
  planRemainder(input: any, schema: any): unknown;
  fullPlan(input: any, schema: any): unknown;
  planRepair(input: any, schema: any): unknown;
  chunk(input: OracleChunkInput): unknown | null;
  other(name: string, input: any, schema: unknown): unknown | undefined;
}

// ---------------------------------------------------------------------------------------
// Конструкторы typed implementation IR — короткие имена, чтобы книги читались как код.
// ---------------------------------------------------------------------------------------
type E = Expression; type S = Statement;
const id = (name: string): E => ({ kind: 'identifier', name });
const lit = (value: string | number | boolean | null): E => ({ kind: 'literal', value });
const prop = (object: E, property: string): E => ({ kind: 'property_access', object, property: id(property), computed: false });
const index = (object: E, key: E): E => ({ kind: 'property_access', object, property: key, computed: true });
const dotted = (path: string): E => path.split('.').reduce<E | null>((acc, part) => acc === null ? id(part) : prop(acc, part), null)!;
const call = (callee: E | string, ...args: E[]): E => ({ kind: 'call', callee: typeof callee === 'string' ? dotted(callee) : callee, arguments: args });
const make = (callee: string, ...args: E[]): E => ({ kind: 'new', callee: id(callee), arguments: args });
const bin = (operator: Extract<E, { kind: 'binary' }>['operator'], left: E, right: E): E => ({ kind: 'binary', operator, left, right });
const logic = (operator: '&&' | '||' | '??', left: E, right: E): E => ({ kind: 'logical', operator, left, right });
const not = (argument: E): E => ({ kind: 'unary', operator: '!', argument });
const typeofE = (argument: E): E => ({ kind: 'unary', operator: 'typeof', argument });
const cond = (test: E, consequent: E, alternate: E): E => ({ kind: 'conditional', test, consequent, alternate });
const obj = (entries: Record<string, E>, spreads: E[] = []): E => ({ kind: 'object', properties: [
  ...spreads.map(expression => ({ kind: 'spread' as const, expression })),
  ...Object.entries(entries).map(([key, value]) => ({ kind: 'property' as const, key, value })),
] });
const arr = (...elements: E[]): E => ({ kind: 'array', elements });
const t = (text: string) => ({ kind: 'type' as const, text });
const p = (name: string, type?: string, optional = false): Parameter => ({ name, ...(type === undefined ? {} : { type: t(type) }), ...(optional ? { optional: true } : {}) });
const arrow = (params: Parameter[], body: E | S[]): E => ({ kind: 'arrow', params, body: Array.isArray(body) ? { kind: 'block', body } : body });
const constDecl = (name: string, initializer: E, options: { type?: string; export?: boolean } = {}): S => ({ kind: 'variable_declaration', declarationKind: 'const', name, initializer,
  ...(options.type === undefined ? {} : { type: t(options.type) }), ...(options.export ? { export: true } : {}) });
const fn = (name: string, params: Parameter[], body: S[], options: { returnType?: string; export?: boolean } = {}): S => ({ kind: 'function_declaration', name, params, body: { kind: 'block', body },
  ...(options.returnType === undefined ? {} : { returnType: t(options.returnType) }), ...(options.export ? { export: true } : {}) });
const ret = (argument?: E): S => ({ kind: 'return', ...(argument === undefined ? {} : { argument }) });
const iff = (test: E, consequent: S, alternate?: S): S => ({ kind: 'if', test, consequent, ...(alternate === undefined ? {} : { alternate }) });
const expr = (expression: E): S => ({ kind: 'expression_statement', expression });
const thr = (error: string, message: E): S => ({ kind: 'throw', argument: make(error, message) });
const imp = (source: string, names: string[], typeOnly = false): S => ({ kind: 'import', source, names: names.map(imported => ({ imported })), ...(typeOnly ? { typeOnly: true } : {}) });
const reexport = (source: string, names: string[], typeOnly = false): S => ({ kind: 'reexport', source, names: names.map(imported => ({ imported })), ...(typeOnly ? { typeOnly: true } : {}) });
const iface = (name: string, properties: { name: string; type: string; optional?: boolean; readonly?: boolean }[], exported = true): S => ({ kind: 'interface_declaration', name,
  properties: properties.map(property => ({ name: property.name, type: t(property.type), ...(property.optional ? { optional: true } : {}), ...(property.readonly ? { readonly: true } : {}) })),
  methods: [], ...(exported ? { export: true } : {}) });
const typeAlias = (name: string, text: string, exported = true): S => ({ kind: 'type_alias_declaration', name, type: t(text), ...(exported ? { export: true } : {}) });
/** Конкатенация вместо шаблонной строки: template literal в IR не представим. */
const concat = (...parts: (E | string)[]): E => parts.map(part => typeof part === 'string' ? lit(part) : part).reduce((acc, part) => bin('+', acc, part));
const undef = (): E => id('undefined');
const isUndefined = (value: E): E => bin('===', value, undef());
const notUndefined = (value: E): E => bin('!==', value, undef());
/** describe/it для нового тестового файла — обычные вызовы с arrow-колбэком. */
const describeBlock = (title: string, tests: { title: string; body: S[] }[]): S =>
  expr(call('describe', lit(title), arrow([], tests.map(test => expr(call('it', lit(test.title), arrow([], test.body)))))));
const assertCall = (name: string, ...args: E[]): S => expr(call(name, ...args));

// ---------------------------------------------------------------------------------------
// Общие сведения о задаче и помощники книги.
// ---------------------------------------------------------------------------------------
const AXES = ['Безопасность', 'Ресурсы и скорость', 'Отказы зависимостей', 'Настройки', 'Совместимость и данные', 'Наблюдаемость'] as const;

interface PlanCardSpec {
  file: string;
  /** Номера пунктов приёмки задачи (1-based) — рантайм даёт им id claim-N в том же порядке. */
  claims: number[];
  /** Индексы карточек (1-based) этого списка, от которых зависит карточка. */
  dependsOn: number[];
  /** Существующий символ файла либо имя нового. */
  symbol: string;
  isNew?: boolean;
  action: string;
  check: string;
  expected: string;
  contract: string;
}

interface AxisSpec { affected: boolean; reason: string; outcome: string }

interface ClaimSpec { procedure: string; expected: string; scenario: string; counterexample: string }

interface ResearchSpec { fact: string; impact: string; change: string | null; reuse?: string | null; risks?: string[]; questions?: { question: string; blocking: boolean }[] }

interface FileCard { path: string; hash: string; symbols: string[]; isNew: boolean; targets?: { symbol: string; targetId: string; executable: boolean }[]; barrel?: boolean; ownedNewContent?: string }
interface Capability { file: string; ops: string[]; symbol?: string }

interface TaskSpec {
  fixture: string;
  title: string;
  /** Поля бланков по ключу (ключ — как в схеме sdlc_form_fields, в нижнем регистре). */
  fields: Record<string, string>;
  lists: Record<string, string[]>;
  claims: ClaimSpec[];
  research: Record<string, ResearchSpec>;
  /** Путь нового теста по умолчанию, если рантайм не назвал mandatoryTestPath. */
  defaultTestPath: string;
  cards: (testPath: string) => PlanCardSpec[];
  approach: string;
  excluded: string[];
  axes: AxisSpec[];
  changes: string;
  callerDecision: string;
  /** Операции chunk для файла; null — файл книге неизвестен. */
  ops: (path: string, card: FileCard | undefined, capability: Capability | undefined, context: { testPath: string; hashOf: (path: string) => string; targetId: (card: FileCard | undefined, symbol: string) => string }) => unknown[] | null;
  prediction: string;
  /** Вопрос человеку (блокирующий), если задача требует отсутствующего бизнес-правила. */
  humanQuestion?: { askOn: string; question: string; missingDecision: string; options: [string, string]; consequence: string;
    /** Как ответ человека ложится в план: какой пункт задачи уточняет и новой формулировкой. */
    resolves: { claim: number; kind: 'подтверждает' | 'уточняет' | 'заменяет'; text: string } };
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Диапазон строк N-го пункта «Что должно получиться» в тексте задачи (request-1). */
function claimLines(taskText: string, ordinal: number, maxLine: number): [number, number] {
  const lines = taskText.split(/\r?\n/u);
  const start = lines.findIndex(line => new RegExp(`^${ordinal}\\.\\s`, 'u').test(line));
  if (start < 0) return [1, Math.min(maxLine, 1)];
  let end = start;
  while (end + 1 < lines.length && !/^\d+\.\s/u.test(lines[end + 1]!) && lines[end + 1]!.trim() !== '' && end - start < 11) end += 1;
  return [Math.min(start + 1, maxLine), Math.min(end + 1, maxLine)];
}

function omit<T extends Record<string, unknown>>(value: T, ...keys: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
}

const walkSchema = (node: unknown, visit: (record: Record<string, unknown>) => void): void => {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach(child => walkSchema(child, visit)); return; }
  visit(node as Record<string, unknown>);
  Object.values(node as Record<string, unknown>).forEach(child => walkSchema(child, visit));
};

/** Enum свойства `property` где-нибудь в схеме (первое попавшееся). */
function enumIn(schema: unknown, property: string): string[] | null {
  let found: string[] | null = null;
  walkSchema(schema, record => {
    if (found) return;
    const target = (record.properties as Record<string, any> | undefined)?.[property];
    if (Array.isArray(target?.enum)) found = target.enum as string[];
    else if (Array.isArray(target?.items?.enum)) found = target.items.enum as string[];
    else {
      const branches: any[] = Array.isArray(target?.anyOf) ? target.anyOf : Array.isArray(target?.oneOf) ? target.oneOf : [];
      const withEnum = branches.find(branch => Array.isArray(branch?.enum));
      if (withEnum) found = withEnum.enum as string[];
    }
  });
  return found;
}

class Book implements OracleBook {
  private readonly spec: TaskSpec;
  private readonly fixtureDir: string;
  private readonly taskText: string;
  private testPath: string;
  private readonly hashes = new Map<string, string>();
  constructor(task: string, spec: TaskSpec) {
    this.spec = spec;
    this.fixtureDir = join(BENCH_DIR, 'fixtures', spec.fixture);
    this.taskText = readFileSync(join(this.fixtureDir, `task-${task}.md`), 'utf8');
    this.testPath = spec.defaultTestPath;
  }

  private hashOf(path: string): string {
    const cached = this.hashes.get(path);
    if (cached) return cached;
    const full = join(this.fixtureDir, path);
    const value = existsSync(full) ? sha256(readFileSync(full, 'utf8')) : 'missing';
    this.hashes.set(path, value);
    return value;
  }

  private cards(): PlanCardSpec[] { return this.spec.cards(this.testPath); }

  private noteTestPath(input: any): void {
    const mandatory = input?.mandatoryTestPath ?? input?.tail?.mandatoryTestPath;
    if (typeof mandatory === 'string' && mandatory) this.testPath = mandatory;
  }

  formField(key: string, _input: any, _property: unknown): string | null {
    const folded = key.toLowerCase().replace(/ё/gu, 'е').trim();
    for (const [name, value] of Object.entries(this.spec.fields)) if (folded === name || folded.includes(name)) return value;
    return null;
  }

  fieldItems(input: any): string[] {
    const key = String(input?.questionId ?? input?.field ?? input?.key ?? '').toLowerCase();
    for (const [name, items] of Object.entries(this.spec.lists)) if (key.includes(name)) return items;
    return [`н/п — по тексту задачи «${this.spec.title}» дополнительных пунктов нет`];
  }

  preparationClaims(schema: any, _input: any): unknown {
    const items = schema?.items;
    const variants: any[] = Array.isArray(items?.oneOf) ? items.oneOf : [items];
    const count = typeof schema?.minItems === 'number' ? schema.minItems : this.spec.claims.length;
    return Array.from({ length: count }, (_, i) => {
      const variant = variants[i] ?? variants[0] ?? {};
      const properties = variant.properties ?? {};
      const claimId: string = properties.id?.const ?? `claim-${i + 1}`;
      const spec = this.spec.claims[i] ?? this.spec.claims.at(-1)!;
      const result: Record<string, unknown> = { id: claimId };
      if (properties.behavior) result.behavior = this.taskClaimText(i + 1);
      if (properties.procedure) result.procedure = spec.procedure;
      if (properties.expected) result.expected = spec.expected;
      if (properties.basis) {
        const basisVariants: any[] = Array.isArray(properties.basis.oneOf) ? properties.basis.oneOf : [properties.basis];
        const first = basisVariants.find(v => v?.properties?.file?.const === 'request-1') ?? basisVariants[0];
        const file: string = first?.properties?.file?.const ?? 'request-1';
        const maxLine: number = first?.properties?.lines?.items?.maximum ?? 999;
        result.basis = { file, lines: claimLines(this.taskText, i + 1, maxLine) };
      }
      if (properties.scenario) result.scenario = spec.scenario;
      if (properties.counterexample) result.counterexample = spec.counterexample;
      return result;
    });
  }

  private taskClaimText(ordinal: number): string {
    const [from, to] = claimLines(this.taskText, ordinal, 9999);
    return this.taskText.split(/\r?\n/u).slice(from - 1, to).join(' ').replace(/^\d+\.\s*/u, '').replace(/\s+/gu, ' ').trim();
  }

  reviewScenarios(): unknown[] { return []; }

  claim(input: any): unknown {
    const claimId = String(input?.claim?.id ?? input?.claimId ?? input?.id ?? '');
    const ordinal = Number(/\d+/u.exec(claimId)?.[0] ?? 1);
    const card = this.cards().find(c => c.claims.includes(ordinal)) ?? this.cards()[0]!;
    return { status: '✅', evidence: `${card.file}: ${card.symbol} — ${card.check}; ${card.expected}`, fix: 'н/п — замечаний нет' };
  }

  failureDiagnosis(input: any, _schema: unknown): unknown {
    // Диагноз должен цитировать вывод дословно и указать строки исходного запроса — иначе
    // parseRepairDiagnosis его отклонит. Падение существующего теста, который задача велела
    // обновить, — расхождение ожидания теста с требованием, а не ошибка реализации.
    const output = String(input?.output ?? '');
    const failures: any[] = Array.isArray(input?.observedTestFailures) ? input.observedTestFailures : [];
    const observed = failures.map(f => String(f?.name ?? '')).find(name => name !== '' && output.includes(name))
      ?? output.split(/\r?\n/u).map(line => line.trim()).find(line => /not ok|✖|Error|error TS/u.test(line) && line.length > 3)
      ?? output.slice(0, 80);
    const existingTestCard = this.cards().find(card => /^tests?\//u.test(card.file) && !card.isNew);
    const existingTestText = existingTestCard && existsSync(join(this.fixtureDir, existingTestCard.file)) ? readFileSync(join(this.fixtureDir, existingTestCard.file), 'utf8') : '';
    // Имя упавшего теста найдено в тексте существующего теста из плана — падает именно он.
    const kind = existingTestCard && failures.some(f => { const name = String(f?.name ?? '').replace(/^\S+\s*-\s*/u, '').trim(); return name !== '' && existingTestText.includes(name); })
      ? 'test-expectation' : 'implementation';
    const ordinal = existingTestCard?.claims[0] ?? this.cards()[0]?.claims[0] ?? 1;
    const lines = claimLines(this.taskText, ordinal, this.taskText.split(/\r?\n/u).length);
    return { kind, reason: kind === 'test-expectation'
        ? `Падает существующий тест формы счёта: задача требует обновить его под новое обязательное поле (${existingTestCard?.file}).`
        : 'Наблюдаемый отказ — расхождение реализации с требованием задачи; ремонт по файлам реализации.',
      observedFailure: observed.slice(0, 600), source: { request: 1, lines } };
  }

  fileResearch(input: any): unknown {
    const path = String(input?.source?.path ?? '');
    const content = String(input?.source?.content ?? '');
    const known = this.spec.research[path];
    const questions = this.spec.humanQuestion && this.spec.humanQuestion.askOn === path ? [{ question: this.spec.humanQuestion.question, blocking: true }] : [];
    if (known) return { fact: known.fact, impact: known.impact, change: known.change, reuse: known.reuse ?? null, risks: known.risks ?? [], questions: [...questions, ...(known.questions ?? [])] };
    let symbols: string[] = [];
    try { symbols = findSymbols(content).map(decl => decl.qualified).slice(0, 12); } catch { /* не TypeScript */ }
    const fact = symbols.length
      ? `Файл ${path} объявляет: ${symbols.join(', ')}. Поведение задано этими объявлениями и не относится к изменяемой части задачи.`
      : `Файл ${path} — ${/\.md$/iu.test(path) ? 'документ проекта' : /test/iu.test(path) ? 'существующий тест, фиксирующий текущее поведение' : 'вспомогательный файл проекта'}; объявлений кода, затрагиваемых задачей, в нём нет.`;
    return { fact, impact: `Для задачи «${this.spec.title}» файл служит контекстом и не меняется.`, change: null, reuse: null, risks: [], questions };
  }

  questionResolution(input: any, schema: any, _askedHuman: number): unknown {
    const branches: any[] = Array.isArray(schema?.anyOf) ? schema.anyOf : [schema];
    const kinds = new Map(branches.map(branch => [branch?.properties?.kind?.enum?.[0] as string, branch]));
    const question = String(input?.question ?? input?.tail?.question ?? '');
    const human = this.spec.humanQuestion;
    if (human && kinds.has('human') && (question === '' || /льгот|ставк|тариф/iu.test(question) || question.includes(human.question.slice(0, 20)))) {
      return { kind: 'human', missingDecision: human.missingDecision, options: human.options, consequence: human.consequence, reason: 'Правило не записано ни в коде, ни в README, ни в тексте задачи — вывести его нельзя, только спросить.' };
    }
    const source = kinds.get('source');
    if (source) {
      const evidence = source.properties?.evidenceId?.enum?.[0];
      return { kind: 'source', ...(evidence === undefined ? {} : { evidenceId: evidence }), answer: 'Ответ следует из показанного источника: текст задачи и исходники фиксируют поведение однозначно.' };
    }
    const engineering = kinds.get('engineering');
    if (engineering) {
      const evidence = engineering.properties?.evidenceId?.enum?.[0];
      const category = engineering.properties?.category?.enum?.[0] ?? 'implementation_detail';
      return { kind: 'engineering', ...(evidence === undefined ? {} : { evidenceId: evidence }), category, choice: 'Следовать соглашениям показанных исходников', reason: 'Обратимое инженерное решение, бизнес-правила не затрагивает.' };
    }
    return fillSchema(branches[0], 'по тексту задачи');
  }

  planOutline(input: any, schema: any): unknown {
    this.noteTestPath(input);
    const allowed = enumIn(schema, 'file');
    // Схема цели: закрытый enum существующих путей и — если рантайм это разрешил — объект нового файла.
    let newFileAllowed = false;
    walkSchema(schema, record => { if ((record.properties as any)?.isNew?.const === true && (record.properties as any)?.path) newFileAllowed = true; });
    const cards = this.cards();
    return { steps: cards.map(card => ({
      file: allowed && !allowed.includes(card.file) && newFileAllowed ? { isNew: true, path: card.file } : card.file,
      claims: card.claims.map(n => `claim-${n}`),
      dependsOn: card.dependsOn,
    })) };
  }

  /** Строки сопоставления ответов человека с пунктами задачи — по списку ответов из схемы. */
  private resolutionRows(schema: any): unknown[] | null {
    const answers = enumIn(schema, 'answer');
    if (!answers?.length) return null;
    const sources = enumIn(schema, 'source') ?? [];
    const human = this.spec.humanQuestion;
    return answers.map(answer => {
      const claim = human ? `claim-${human.resolves.claim}` : sources[0] ?? 'claim-1';
      return { answer, source: sources.includes(claim) ? claim : sources[0] ?? claim, kind: human?.resolves.kind ?? 'подтверждает',
        text: human?.resolves.text ?? 'ответ человека подтверждает требование в исходной формулировке' };
    });
  }

  planCard(input: any, schema: any): unknown {
    this.noteTestPath(input);
    const tail = input?.tail ?? input;
    const target = tail?.target ?? {};
    const file: string = target.file ?? '';
    const card = this.cards().find(c => c.file === file) ?? this.cards()[Number(tail?.card ?? 1) - 1] ?? this.cards()[0]!;
    const known = knownSymbolEnum(schema);
    const symbol = !card.isNew && known.includes(card.symbol) ? card.symbol : { isNew: true, name: card.symbol };
    return { symbol, action: card.action, check: card.check, expected: card.expected, contract: card.contract };
  }

  planRemainder(input: any, schema: any): unknown {
    const tail = input?.tail ?? {};
    const steps: any[] = Array.isArray(tail.steps) ? tail.steps : [];
    const cited = steps.map(step => `${step.file}:${typeof step.symbol === 'string' ? step.symbol : step.symbol?.name ?? ''}`).join(', ');
    const callerCount = (input?.callerFacts ?? []).reduce((n: number, fact: any) => n + (Array.isArray(fact.callers) ? fact.callers.length : 0), 0);
    const callersMin = schema?.properties?.callers?.minItems;
    const count = typeof callersMin === 'number' ? callersMin : callerCount;
    const resolutions = schema?.properties?.resolutions ? this.resolutionRows(schema.properties.resolutions) : null;
    return {
      approach: `${this.spec.approach} Карточки: ${cited || 'по плану'}.`,
      excluded: this.spec.excluded,
      axes: this.spec.axes.map(axis => ({ affected: axis.affected, reason: axis.reason, outcome: axis.outcome })),
      changes: this.spec.changes,
      callers: Array.from({ length: count }, () => ({ decision: this.spec.callerDecision })),
      ...(resolutions === null ? {} : { resolutions }),
    };
  }

  fullPlan(input: any, schema: any): unknown {
    this.noteTestPath(input);
    const known = knownSymbolEnum(schema);
    const cards = this.cards();
    const callerCount = (input?.callerFacts ?? []).reduce((n: number, fact: any) => n + (Array.isArray(fact.callers) ? fact.callers.length : 0), 0);
    return {
      approach: `${this.spec.approach} Карточки: ${cards.map(card => `${card.file}:${card.symbol}`).join(', ')}.`,
      steps: cards.map(card => ({ file: card.file, symbol: !card.isNew && known.includes(card.symbol) ? card.symbol : { isNew: true, name: card.symbol },
        action: card.action, claims: card.claims.map(n => `claim-${n}`), check: card.check, expected: card.expected, contract: card.contract, dependsOn: card.dependsOn })),
      excluded: this.spec.excluded,
      axes: this.spec.axes.map((axis, i) => ({ name: AXES[i], affected: axis.affected, reason: axis.reason, outcome: axis.outcome })),
      changes: this.spec.changes,
      callers: Array.from({ length: callerCount }, () => ({ decision: this.spec.callerDecision })),
    };
  }

  planRepair(input: any, schema: any): unknown {
    this.noteTestPath(input);
    const focus = input?.repairFocus;
    const operations: unknown[] = [];
    const opNames = new Set<string>();
    walkSchema(schema, record => { const op = (record.properties as any)?.op?.const; if (typeof op === 'string') opNames.add(op); });
    if (focus === 'axes' && opNames.has('setAxis')) {
      this.spec.axes.forEach((axis, i) => operations.push({ op: 'setAxis', name: AXES[i], affected: axis.affected, reason: axis.reason, outcome: axis.outcome }));
      return { version: 1, operations };
    }
    if (focus === 'approach' && opNames.has('setApproach')) {
      return { version: 1, operations: [{ op: 'setApproach', value: `${this.spec.approach} Карточки: ${this.cards().map(card => `${card.file}:${card.symbol}`).join(', ')}.` }] };
    }
    const previous: any[] = input?.previousPlan?.steps ?? [];
    const feedback = String(input?.feedback ?? '');
    // Отзыв стража о таблице ответов человека чинится одной операцией на ответ.
    if (opNames.has('setResolution') && /ID ответа|ответ-\d+|ответы человека/iu.test(feedback)) {
      const rows = this.resolutionRows(schema) ?? [];
      if (rows.length) return { version: 1, operations: rows.map(row => ({ op: 'setResolution', ...(row as object) })) };
    }
    const owners: number[] = Array.isArray(input?.targetOwners) && input.targetOwners.length ? input.targetOwners
      : Array.isArray(input?.repairTargets) && input.repairTargets.length ? input.repairTargets : previous.map(step => step.id);
    const allowedPaths: string[] | null = Array.isArray(input?.allowedTargetPaths) ? input.allowedTargetPaths : null;
    const known = knownSymbolEnum(schema);
    for (const stepId of owners) {
      const step = previous.find(candidate => candidate.id === stepId);
      const card = this.cards().find(c => c.file === step?.file) ?? this.cards().find(c => allowedPaths?.includes(c.file) && !previous.some(other => other.file === c.file));
      if (!card) continue;
      const symbol = !card.isNew && known.includes(card.symbol) ? card.symbol : { isNew: true, name: card.symbol };
      if (opNames.has('setTarget') && (allowedPaths === null || allowedPaths.includes(card.file))) operations.push({ op: 'setTarget', stepId, file: card.file, symbol });
      if (opNames.has('setAction')) operations.push({ op: 'setAction', stepId, value: card.action });
      if (opNames.has('setCheck')) operations.push({ op: 'setCheck', stepId, check: card.check, expected: card.expected });
      if (opNames.has('setContract')) operations.push({ op: 'setContract', stepId, value: card.contract });
    }
    if (!operations.length) return fillSchema(schema, 'ремонт плана');
    return { version: 1, operations };
  }

  chunk({ input, evidenceIds, boundFile }: OracleChunkInput): unknown | null {
    this.noteTestPath(input);
    const files: FileCard[] = Array.isArray(input?.files) ? input.files : [];
    const capabilities: Capability[] = Array.isArray(input?.capabilities) ? input.capabilities : [];
    const writable = boundFile ? [boundFile] : capabilities.map(capability => capability.file);
    const evidence = evidenceIds.length ? { evidenceIds: evidenceIds.slice(0, 40) } : {};
    const context = { testPath: this.testPath, hashOf: (path: string) => this.hashOf(path),
      targetId: (card: FileCard | undefined, symbol: string) => card?.targets?.find(target => target.symbol === symbol)?.targetId ?? 'missing-target' };
    const ops: Record<string, unknown>[] = [];
    for (const path of writable) {
      const card = files.find(file => file.path === path);
      const capability = capabilities.find(value => value.file === path);
      const isTest = /(?:^|\/)test\//u.test(path) && path !== this.testPath && !card?.isNew;
      // Новый тест из плана может называться иначе, чем ожидала книга: путь задаёт рантайм.
      if (card?.isNew && /\.test\.[cm]?[jt]s$/u.test(path)) this.testPath = path;
      const unchanged = card === undefined || card.isNew || card.hash === this.hashOf(path) || card.hash === 'missing';
      if (!unchanged || isTest && !this.spec.ops(path, card, capability, context)) continue;
      const fileOps = this.spec.ops(path, card, capability, { ...context, testPath: this.testPath });
      // Файл, которого книга не планировала, но рантайм включил в план сам (материализованная
      // карточка по упоминанию пути в запросе): правок по задаче в нём нет — честный no_change.
      if (fileOps === null) {
        if (card !== undefined && !card.isNew) continue;
        return null;
      }
      for (const op of fileOps as Record<string, unknown>[]) ops.push(boundFile ? omit(op, 'file') : op);
    }
    if (!ops.length) return { action: 'no_change', reason: 'Файлы шага уже содержат требуемое изменение; дальнейших правок для этого шага нет.', ...evidence };
    return { action: 'patch', prediction: this.spec.prediction, ...evidence, ops };
  }

  other(name: string, input: any, schema: unknown): unknown | undefined {
    if (name === 'stage_decision_check') return { decision: `Решение этапа согласовано с текстом задачи «${this.spec.title}» и показанными исходниками.`, evidence: [], uncertainties: [], next: { action: 'proceed', reason: 'Оснований достаточно: требования и исходники прочитаны.' } };
    if (name === 'no_change_review') {
      // Рантайм принимает одобрение только с точными выдержками из исходника и контракта:
      // берём строку исходника с экспортом (публичный вход) и строку контракта, называющую путь.
      const source = typeof input?.source === 'string' ? input.source : '';
      const contract = typeof input?.contract === 'string' ? input.contract : '';
      const path = typeof input?.path === 'string' ? input.path : '';
      const lines = (text: string): string[] => text.split('\n').map(line => line.trim()).filter(Boolean);
      const sourceQuote = lines(source).find(line => /^export\b/u.test(line)) ?? lines(source)[0] ?? '';
      const requirementQuote = lines(contract).find(line => path !== '' && line.includes(path) && !/^#/u.test(line)) ?? lines(contract).find(line => !/^#/u.test(line)) ?? '';
      return { accepted: true, reason: `Файл ${path} уже содержит требуемое: правок по контракту в нём не нужно.`, sourceQuote, requirementQuote };
    }
    if (name === 'plan_selection' || name === 'chunk_selection') {
      const candidates = enumIn(schema, 'selected');
      return { selected: candidates?.[0] ?? null, outcome: candidates?.length ? 'select' : 'insufficient_evidence', reason: 'Кандидат соответствует требованиям и плану.' };
    }
    if (name === 'intent_contract_repair' || name === 'guided_contract_repair') return fillSchema(schema, this.spec.fields['что делаем'] ?? this.spec.title);
    if (name === 'guided_plan_repair') return { steps: [], removeSteps: [], approach: null, axes: null, excluded: null, changes: null, callers: null };
    void input;
    return undefined;
  }
}

function knownSymbolEnum(schema: unknown): string[] {
  let found: string[] = [];
  walkSchema(schema, record => {
    if (found.length) return;
    const symbol = (record.properties as Record<string, any> | undefined)?.symbol;
    if (!symbol) return;
    const branches: any[] = Array.isArray(symbol.anyOf) ? symbol.anyOf : Array.isArray(symbol.oneOf) ? symbol.oneOf : [symbol];
    for (const branch of branches) if (Array.isArray(branch?.enum)) { found = branch.enum as string[]; return; }
  });
  return found;
}

/** Заполнить схему осмысленным текстом — для редких схем, не заслуживающих отдельной книги. */
function fillSchema(schema: unknown, hint: string): unknown {
  if (!schema || typeof schema !== 'object') return hint;
  const s = schema as Record<string, any>;
  if ('const' in s) return s.const;
  if (Array.isArray(s.enum) && s.enum.length) return s.enum[0];
  const branches = (s.oneOf ?? s.anyOf) as unknown[] | undefined;
  if (Array.isArray(branches) && branches.length) return fillSchema(branches[0], hint);
  const type = Array.isArray(s.type) ? s.type[0] : s.type;
  if (type === 'string') { const min = typeof s.minLength === 'number' ? s.minLength : 1; return hint.length >= min ? hint : hint.padEnd(min, '.'); }
  if (type === 'integer' || type === 'number') return typeof s.minimum === 'number' ? s.minimum : 1;
  if (type === 'boolean') return false;
  if (type === 'null') return null;
  if (type === 'array') return Array.from({ length: typeof s.minItems === 'number' ? s.minItems : 0 }, () => fillSchema(s.items, hint));
  if (type === 'object' || s.properties) {
    const properties = (s.properties ?? {}) as Record<string, unknown>;
    const required = new Set((s.required as string[] | undefined) ?? Object.keys(properties));
    return Object.fromEntries(Object.entries(properties).filter(([key]) => required.has(key)).map(([key, value]) => [key, fillSchema(value, hint)]));
  }
  return hint;
}

// ---------------------------------------------------------------------------------------
// Общие операции chunk.
// ---------------------------------------------------------------------------------------
const replaceDeclaration = (file: string, card: FileCard | undefined, symbol: string, declaration: S, targetId: (card: FileCard | undefined, symbol: string) => string) =>
  ({ op: 'replace_declaration_ir', file, symbol, targetId: targetId(card, symbol), expectedHash: card?.hash ?? 'missing', declaration });
const insertBefore = (file: string, anchor: string, declarations: S[]) => ({ op: 'insert_before_ir', file, anchor, declarations });
const insertAfter = (file: string, anchor: string, declarations: S[]) => ({ op: 'insert_after_ir', file, anchor, declarations });
const createModule = (file: string, body: S[]) => ({ op: 'create_file_ir', file, module: { version: 1, body } });
const replaceText = (file: string, card: FileCard | undefined, search: string, replacement: string) => ({ op: 'replace_text', file, expectedHash: card?.hash ?? 'missing', search, replacement });
/**
 * Реэкспорт из barrel-файла. Карточка файла признак barrel модели не показывает — его
 * выдаёт только список capabilities; statement `reexport` в позиции вставки компилятор IR
 * не принимает, поэтому вне barrel реэкспорт недостижим типизированными операциями.
 */
const reexportFrom = (file: string, card: FileCard | undefined, capability: Capability | undefined, source: string, names: string[]) =>
  capability === undefined || capability.ops.includes('ensure_reexport')
    ? { op: 'ensure_reexport', file, from: source, names }
    : insertAfter(file, card?.symbols.at(-1) ?? 'bill', [reexport(source, names)]);

const customerLiteral = (email: string, phone: string): E => obj({ name: lit('Иван'), email: lit(email), phone: lit(phone) });

// ---------------------------------------------------------------------------------------
// add-validator: новый модуль валидации покупателя, реэкспорт, новый тест.
// ---------------------------------------------------------------------------------------
const addValidator: TaskSpec = {
  fixture: 'billing',
  title: 'Валидация покупателя',
  fields: {
    'название': 'Валидация покупателя при выставлении счёта',
    'зачем': 'Счета выставляются на данные формы заказа как есть: опечатка в email или телефоне обнаруживается неделю спустя неоплаченным счётом. Валидация на выставлении ловит её сразу.',
    'коротко': 'Новый чистый модуль src/validate.ts с validateCustomer(customer): string[] — коды нарушений email и phone в фиксированном порядке; реэкспорт из src/index.ts; новый тест в test/.',
    'что делаем': 'Добавляем src/validate.ts с validateCustomer(customer), возвращающей список кодов нарушений: сначала email (ровно одна @, непустая локальная часть, домен с точкой не по краям, без пробелов), затем phone (+7 или 8 и ровно 10 цифр). Реэкспортируем validateCustomer из src/index.ts. Пишем тест рядом с существующими и прогоняем набор командой проекта.',
    'чего не делаем': 'Не встраиваем валидацию в buildInvoice и не меняем существующие модули (src/invoice.ts, src/money.ts, src/lines.ts, src/config.ts) и существующие тесты.',
    'предположен': 'Форма заказа не ставит пробелов, скобок и дефисов в телефоне — другие символы считаются нарушением.',
    'инвариант': 'Существующие модули и тесты остаются без изменений; validateCustomer — чистая функция без побочных эффектов.',
    'остановиться': 'Если потребуется менять сборку счёта или существующие тесты — остановиться и спросить.',
  },
  lists: {},
  claims: [
    { procedure: 'Вызвать validateCustomer из src/validate.ts для валидного и для невалидного покупателя и сравнить возвращённые массивы.', expected: 'Для валидного — [], для нарушений — коды в порядке [\'email\', \'phone\']; аргумент не изменён.', scenario: 'validateCustomer({name, email: "ivan@example.ru", phone: "+79001234567"}) возвращает пустой список; при ошибках в обоих полях — ["email", "phone"].', counterexample: 'Функция возвращает ["phone", "email"] или мутирует переданный объект.' },
    { procedure: 'Передать email без @, с двумя @, с пустой локальной частью, с доменом без точки или с точкой по краям, с пробелом.', expected: 'Каждый вариант даёт код email; корректный адрес вида local@domain.tld кода не даёт.', scenario: 'validateCustomer с email "ivan@example" возвращает ["email"]; с "ivan@example.ru" — без кода email.', counterexample: 'Адрес "ivan@@example.ru" или "ivan@.example.ru" проходит без кода email.' },
    { procedure: 'Передать телефон +7 с 10 цифрами, 8 с 10 цифрами, 9 цифрами, с пробелами и скобками.', expected: 'Только +7XXXXXXXXXX и 8XXXXXXXXXX проходят; остальное даёт код phone.', scenario: 'validateCustomer с phone "+7 900 123 45 67" возвращает ["phone"]; с "89001234567" — без кода phone.', counterexample: 'Телефон с пробелами или 9 цифрами проходит без кода phone.' },
    { procedure: 'Импортировать validateCustomer из src/index.ts; запустить node --test "test/**/*.test.ts" и прочитать вывод команды.', expected: 'Импорт из публичного контракта работает; новый тест рядом с существующими зелёный; вывод команды попадает в журнал этапа.', scenario: 'import { validateCustomer } from "../src/index.ts" в новом тесте test/ проходит, набор зелёный.', counterexample: 'validateCustomer доступна только из src/validate.ts или новый тест отсутствует.' },
    { procedure: 'Сравнить git diff существующих модулей и тестов с базой.', expected: 'src/invoice.ts, src/money.ts, src/lines.ts, src/config.ts и существующие тесты не изменены; buildInvoice валидацию не вызывает.', scenario: 'После реализации diff затрагивает только src/validate.ts, src/index.ts и новый тест.', counterexample: 'buildInvoice вызывает validateCustomer или изменён существующий тест.' },
  ],
  research: {
    'src/customer.ts': { fact: 'Customer — интерфейс {name, email, phone}; данные приходят из формы заказа как есть, валидации нет по замыслу: валидирует тот, кто выставляет счёт.', impact: 'validateCustomer принимает Customer этого типа; файл менять не нужно.', change: null, reuse: 'Тип Customer импортируется в новый модуль как type-only.' },
    'src/index.ts': { fact: 'Публичный контракт: реэкспортирует money, lines, customer, config, invoice и объявляет bill(number, customer, lines, config?).', impact: 'Сюда добавляется реэкспорт validateCustomer из ./validate.ts; остальные экспорты сохраняются.', change: 'Добавить реэкспорт validateCustomer из ./validate.ts.', reuse: null },
    'src/invoice.ts': { fact: 'buildInvoice собирает счёт из позиций через resolveConfig и subtotal; валидацию покупателя не вызывает.', impact: 'По задаче не трогается: встраивать валидацию в сборку счёта — отдельное решение.', change: null, reuse: null, risks: ['Встроить validateCustomer в buildInvoice запрещено рамками задачи.'] },
    'src/money.ts': { fact: 'Деньги в копейках: rub, add, subtract, percent (половина вверх), formatRub.', impact: 'К валидации не относится; не меняется.', change: null, reuse: null },
    'src/lines.ts': { fact: 'Line {title, qty, priceK}; lineTotal и subtotal считают стоимость позиций.', impact: 'К валидации не относится; не меняется.', change: null, reuse: null },
    'src/config.ts': { fact: 'BillingConfig {currency}, DEFAULT_CONFIG и resolveConfig с переопределениями площадки.', impact: 'К валидации не относится; не меняется.', change: null, reuse: null },
  },
  defaultTestPath: 'test/validate.test.ts',
  cards: testPath => [
    { file: 'src/validate.ts', claims: [1, 2, 3], dependsOn: [], symbol: 'validateCustomer', isNew: true,
      action: 'Создать модуль с чистой функцией validateCustomer(customer): string[], проверяющей email (одна @, непустая локальная часть, домен с точкой не по краям, без пробелов) и телефон (+7 или 8 и ровно 10 цифр) и возвращающей коды в порядке email, phone.',
      check: 'Вызвать validateCustomer для валидного покупателя и для нарушений в email, phone и обоих полях; сравнить массивы.', expected: 'Валидный — []; нарушения — ["email"], ["phone"], ["email", "phone"] соответственно; аргумент не изменён.',
      contract: 'Новый экспорт validateCustomer; существующих контрактов не меняет.' },
    { file: 'src/index.ts', claims: [4], dependsOn: [1], symbol: 'validateCustomer', isNew: true,
      action: 'Добавить реэкспорт validateCustomer из ./validate.ts в публичный контракт, не меняя прочие экспорты и bill.',
      check: 'Импортировать validateCustomer из src/index.ts и вызвать её.', expected: 'Импорт работает, прежние экспорты (bill, buildInvoice, money, lines, config) сохранены.',
      contract: 'Публичный контракт расширяется новым именем validateCustomer; прежний API без изменений.' },
    { file: testPath, claims: [4, 5], dependsOn: [1, 2], symbol: 'validateCustomerTests', isNew: true,
      action: 'Написать тест валидного покупателя, порядка кодов и правил email/телефона, импортируя validateCustomer из ../src/index.ts.',
      check: 'Запустить node --test "test/**/*.test.ts" командой проекта и прочитать вывод.', expected: 'Новый тест зелёный вместе с существующими; существующие тесты и модули не изменены.',
      contract: 'н/п — тест не меняет контрактов.' },
  ],
  approach: 'Валидация вынесена в отдельный чистый модуль src/validate.ts (validateCustomer), публикуется реэкспортом из src/index.ts и покрывается новым тестом; сборка счёта (src/invoice.ts:buildInvoice) не вызывает валидацию по рамкам задачи. Альтернатива — встроить проверку в buildInvoice — отвергнута текстом задачи.',
  excluded: ['Не менять src/invoice.ts, src/money.ts, src/lines.ts, src/config.ts', 'Не править существующие тесты', 'Не вызывать валидацию из buildInvoice'],
  axes: [
    { affected: false, reason: 'Функция чистая, читает только поля Customer, секретов и внешних вызовов нет.', outcome: 'н/п — нет новых входов извне и побочных эффектов' },
    { affected: false, reason: 'Две проверки регулярными выражениями на строку, без аллокаций в цикле.', outcome: 'н/п — константная стоимость вызова' },
    { affected: false, reason: 'Внешних зависимостей модуль не имеет.', outcome: 'н/п — зависимостей нет' },
    { affected: false, reason: 'Правила валидации фиксированы задачей, настроек не добавляется.', outcome: 'н/п — настроек нет' },
    { affected: true, reason: 'Публичный контракт src/index.ts получает новый экспорт validateCustomer; прежние имена сохранены.', outcome: 'claim-4' },
    { affected: false, reason: 'Функция возвращает коды нарушений вызывающему; журналирования не требуется.', outcome: 'н/п — результат возвращается явно' },
  ],
  changes: 'Нет изменений требований.',
  callerDecision: 'Контракт вызывающего не меняется: новый экспорт добавляется, существующие сигнатуры сохранены.',
  prediction: 'Появится чистая функция validateCustomer с кодами email и phone, её реэкспорт из публичного контракта и новый зелёный тест.',
  ops: (path, card, capability, { testPath, targetId }) => {
    if (path === 'src/validate.ts') return [createModule(path, [
      imp('./customer.ts', ['Customer'], true),
      constDecl('emailPattern', make('RegExp', lit('^[^\\s@]+@(?=[^\\s@]*\\.)[^\\s@.](?:[^\\s@]*[^\\s@.])?$'))),
      constDecl('phonePattern', make('RegExp', lit('^(?:\\+7|8)[0-9]{10}$'))),
      fn('validateCustomer', [p('customer', 'Customer')], [
        constDecl('codes', arr(), { type: 'string[]' }),
        iff(not(call(prop(id('emailPattern'), 'test'), prop(id('customer'), 'email'))), expr(call(prop(id('codes'), 'push'), lit('email')))),
        iff(not(call(prop(id('phonePattern'), 'test'), prop(id('customer'), 'phone'))), expr(call(prop(id('codes'), 'push'), lit('phone')))),
        ret(id('codes')),
      ], { returnType: 'string[]', export: true }),
    ])];
    if (path === 'src/index.ts') return [reexportFrom(path, card, capability, './validate.ts', ['validateCustomer'])];
    if (path === testPath) return [createModule(path, [
      imp('node:assert/strict', ['deepStrictEqual']),
      imp('node:test', ['describe', 'it']),
      imp('../src/index.ts', ['validateCustomer']),
      describeBlock('валидация покупателя', [
        { title: 'валидный покупатель — пустой список', body: [assertCall('deepStrictEqual', call('validateCustomer', customerLiteral('ivan@example.ru', '+79001234567')), arr())] },
        { title: 'коды нарушений идут в фиксированном порядке: email, затем phone', body: [assertCall('deepStrictEqual', call('validateCustomer', customerLiteral('ivan@@example.ru', '8900123456')), arr(lit('email'), lit('phone')))] },
        { title: 'телефон: 8 и десять цифр валиден, пробелы и скобки — нарушение', body: [
          assertCall('deepStrictEqual', call('validateCustomer', customerLiteral('ivan@example.ru', '89001234567')), arr()),
          assertCall('deepStrictEqual', call('validateCustomer', customerLiteral('ivan@example.ru', '+7 (900) 123-45-67')), arr(lit('phone'))),
        ] },
        { title: 'email: домен без точки, точка по краям, пробел или вторая @ — нарушение', body: [
          assertCall('deepStrictEqual', call('validateCustomer', customerLiteral('ivan@example', '+79001234567')), arr(lit('email'))),
          assertCall('deepStrictEqual', call('validateCustomer', customerLiteral('ivan@.example.ru', '+79001234567')), arr(lit('email'))),
          assertCall('deepStrictEqual', call('validateCustomer', customerLiteral('ivan@example.ru.', '+79001234567')), arr(lit('email'))),
          assertCall('deepStrictEqual', call('validateCustomer', customerLiteral('iv an@example.ru', '+79001234567')), arr(lit('email'))),
          assertCall('deepStrictEqual', call('validateCustomer', customerLiteral('@example.ru', '+79001234567')), arr(lit('email'))),
        ] },
      ]),
    ])];
    void targetId;
    return null;
  },
};

// ---------------------------------------------------------------------------------------
// config-default: опция defaultDueDays, поле dueDays, opts пятым параметром, README, тест.
// ---------------------------------------------------------------------------------------
const billingLines = (): E => arr(obj({ title: lit('Пакет'), qty: lit(1), priceK: lit(100) }));
const configDefault: TaskSpec = {
  fixture: 'billing',
  title: 'Срок оплаты по умолчанию',
  fields: {
    'название': 'Срок оплаты счёта по умолчанию из конфига площадки',
    'зачем': 'У счёта нет срока оплаты, и покупатель трактует его как «когда-нибудь». Срок, заданный конфигом площадки с встроенным умолчанием 14 дней, делает ожидание явным.',
    'коротко': 'BillingConfig получает defaultDueDays (встроенный дефолт 14); Invoice получает обязательное dueDays; bill/buildInvoice принимают opts пятым параметром с opts.dueDays; README дополнен строкой; тест формы счёта обновлён до шести полей, новый тест добавлен.',
    'что делаем': 'Добавляем defaultDueDays в BillingConfig и DEFAULT_CONFIG (14). Добавляем dueDays: number в Invoice — всегда, источник по приоритету: opts.dueDays → конфиг → 14. Расширяем bill(number, customer, lines, config?, opts?) и buildInvoice тем же параметром. Дополняем таблицу «Конфигурация» README строкой про defaultDueDays. Обновляем тест «ровно пять полей» в test/invoice.test.ts до шести полей и добавляем тест нового поведения; набор прогоняем командой проекта.',
    'чего не делаем': 'Не меняем src/money.ts, test/money.test.ts и test/lines.test.ts; не меняем остальные поля Invoice; чтение конфига остаётся через resolveConfig, прямых обращений к DEFAULT_CONFIG не появляется.',
    'предположен': 'dueDays — целое число дней; валидация значения не требуется задачей.',
    'инвариант': 'Конфиг читается только через resolveConfig; остальные поля Invoice не меняются.',
    'остановиться': 'Если потребуется менять src/money.ts или существующие тесты сверх теста формы счёта — остановиться и спросить.',
  },
  lists: {},
  claims: [
    { procedure: 'Прочитать resolveConfig() без аргументов и с {defaultDueDays: 30}.', expected: 'Без переопределения defaultDueDays равен 14; с переопределением — 30.', scenario: 'resolveConfig().defaultDueDays === 14; resolveConfig({defaultDueDays: 30}).defaultDueDays === 30.', counterexample: 'В BillingConfig нет defaultDueDays или встроенное значение не 14.' },
    { procedure: 'Вызвать bill без opts, с config {defaultDueDays: 30} и с opts {dueDays: 7}; прочитать dueDays счёта.', expected: 'dueDays присутствует всегда: 14, 30 и 7 соответственно — явная опция побеждает конфиг, конфиг побеждает встроенное значение.', scenario: 'bill("СЧ-1", customer, lines).dueDays === 14; bill(..., {defaultDueDays: 30}).dueDays === 30; bill(..., undefined, {dueDays: 7}).dueDays === 7.', counterexample: 'У счёта без опций нет dueDays, либо opts.dueDays не побеждает конфиг.' },
    { procedure: 'Прочитать раздел «Конфигурация» README.md.', expected: 'В таблице опций есть строка про defaultDueDays с умолчанием 14.', scenario: 'README.md содержит строку таблицы с `defaultDueDays` и `14`.', counterexample: 'Таблица опций README не упоминает defaultDueDays.' },
    { procedure: 'Поискать обращения к DEFAULT_CONFIG в src/ кроме config.ts.', expected: 'Чтение конфига идёт через resolveConfig; прямых обращений к DEFAULT_CONFIG в модулях нет.', scenario: 'grep DEFAULT_CONFIG src/ находит только src/config.ts и реэкспорт в src/index.ts.', counterexample: 'buildInvoice читает DEFAULT_CONFIG.defaultDueDays напрямую.' },
    { procedure: 'Запустить node --test "test/**/*.test.ts" командой проекта и прочитать вывод.', expected: 'Новый тест зелёный; существующие тесты не правлены, кроме теста формы счёта «ровно пять полей», обновлённого до шести полей.', scenario: 'Набор зелёный; diff test/ затрагивает только новый тест и тест формы в test/invoice.test.ts.', counterexample: 'Изменён test/money.test.ts или test/lines.test.ts, либо тест формы оставлен на пяти полях и падает.' },
  ],
  research: {
    'src/config.ts': { fact: 'BillingConfig {currency: "RUB"}, DEFAULT_CONFIG и resolveConfig(partial) — единственная точка чтения конфига с переопределениями площадки.', impact: 'Сюда добавляется опция defaultDueDays со встроенным значением 14.', change: 'Добавить defaultDueDays: number в BillingConfig и 14 в DEFAULT_CONFIG.', reuse: 'resolveConfig остаётся единственным способом чтения конфига.' },
    'src/invoice.ts': { fact: 'Invoice {number, customer, lines, subtotal, total}; buildInvoice(number, customer, lines, config?) читает конфиг через resolveConfig и собирает счёт.', impact: 'Invoice получает dueDays: number; buildInvoice — пятый параметр opts с dueDays и приоритет opts → конфиг → 14.', change: 'Добавить dueDays в Invoice и opts?: {dueDays?: number} в buildInvoice.', reuse: null },
    'src/index.ts': { fact: 'Публичный контракт; bill(number, customer, lines, config?) делегирует buildInvoice.', impact: 'bill получает пятый параметр opts и передаёт его в buildInvoice.', change: 'Расширить bill параметром opts?: {dueDays?: number}.', reuse: null },
    'README.md': { fact: 'Раздел «Конфигурация» содержит таблицу опций с единственной строкой currency.', impact: 'Таблица дополняется строкой defaultDueDays.', change: 'Добавить строку таблицы про defaultDueDays (умолчание 14).', reuse: null },
    'test/invoice.test.ts': { fact: 'Тест «форма счёта — ровно пять полей» сверяет ключи Invoice литералом из пяти имён.', impact: 'Обязательное dueDays неизбежно меняет форму; задача велит обновить этот тест до шести полей.', change: 'Обновить ожидаемый список ключей до шести полей с dueDays.', reuse: null, risks: ['Правка существующего теста ограничена одним тестом формы счёта.'] },
    'src/money.ts': { fact: 'Деньги в копейках: rub, add, subtract, percent, formatRub.', impact: 'Не меняется.', change: null, reuse: null },
    'src/lines.ts': { fact: 'Line и subtotal по позициям.', impact: 'Не меняется.', change: null, reuse: null },
    'src/customer.ts': { fact: 'Customer {name, email, phone}.', impact: 'Не меняется.', change: null, reuse: null },
  },
  defaultTestPath: 'test/dueDays.test.ts',
  cards: testPath => [
    { file: 'src/config.ts', claims: [1, 4], dependsOn: [], symbol: 'BillingConfig',
      action: 'Добавить в BillingConfig опцию defaultDueDays: number и значение 14 в DEFAULT_CONFIG; resolveConfig без изменений.',
      check: 'Вызвать resolveConfig() и resolveConfig({defaultDueDays: 30}).', expected: 'defaultDueDays равен 14 и 30 соответственно.',
      contract: 'BillingConfig получает обязательное поле defaultDueDays; потребители через resolveConfig получают 14 по умолчанию.' },
    { file: 'src/invoice.ts', claims: [2], dependsOn: [1], symbol: 'buildInvoice',
      action: 'Добавить dueDays: number в Invoice и пятый параметр opts?: {dueDays?: number} в buildInvoice; значение: opts.dueDays, иначе resolveConfig(config).defaultDueDays.',
      check: 'Собрать счёт без opts, с конфигом defaultDueDays 30 и с opts.dueDays 7.', expected: 'dueDays равен 14, 30 и 7; остальные поля без изменений.',
      contract: 'Invoice получает обязательное поле dueDays; buildInvoice принимает необязательный пятый параметр, прежние вызовы законны.' },
    { file: 'src/index.ts', claims: [2], dependsOn: [2], symbol: 'bill',
      action: 'Расширить bill(number, customer, lines, config?, opts?) и передать opts в buildInvoice.',
      check: 'Вызвать bill с opts {dueDays: 7}.', expected: 'Счёт содержит dueDays 7; вызовы с четырьмя аргументами по-прежнему работают.',
      contract: 'Публичный bill получает необязательный пятый параметр; прежняя сигнатура совместима.' },
    { file: 'README.md', claims: [3], dependsOn: [1], symbol: 'README', isNew: true,
      action: 'Дополнить таблицу раздела «Конфигурация» строкой про defaultDueDays с умолчанием 14.',
      check: 'Прочитать README.md.', expected: 'Таблица опций содержит строку defaultDueDays | 14.',
      contract: 'н/п — документация.' },
    { file: 'test/invoice.test.ts', claims: [5], dependsOn: [2, 3], symbol: 'invoiceFormTest', isNew: true,
      action: 'Обновить тест «форма счёта — ровно пять полей» под шесть полей с dueDays; остальные тесты файла не трогать.',
      check: 'Запустить node --test "test/**/*.test.ts".', expected: 'Тест формы счёта зелёный с шестью ключами.',
      contract: 'н/п — тест.' },
    { file: testPath, claims: [5], dependsOn: [2, 3], symbol: 'dueDaysTests', isNew: true,
      action: 'Написать тест приоритета источников dueDays: встроенные 14, конфиг площадки, явная опция вызова.',
      check: 'Запустить node --test "test/**/*.test.ts" и прочитать вывод.', expected: 'Новый тест зелёный вместе с существующими.',
      contract: 'н/п — тест.' },
  ],
  approach: 'Опция добавляется в конфиг (src/config.ts:BillingConfig, DEFAULT_CONFIG), счёт получает обязательное dueDays с приоритетом opts → конфиг → 14 в src/invoice.ts:buildInvoice, публичный src/index.ts:bill передаёт opts; README документирует опцию. Альтернатива — необязательное dueDays только при явной опции — противоречит требованию «всегда».',
  excluded: ['Не менять src/money.ts, test/money.test.ts, test/lines.test.ts', 'Не менять остальные поля Invoice', 'Не обращаться к DEFAULT_CONFIG напрямую из модулей'],
  axes: [
    { affected: false, reason: 'Новое поле — число дней из конфига или вызова; внешних входов и секретов нет.', outcome: 'н/п — нет новых внешних входов' },
    { affected: false, reason: 'Одно чтение конфига и одно присваивание на счёт.', outcome: 'н/п — константная стоимость' },
    { affected: false, reason: 'Внешних зависимостей нет.', outcome: 'н/п — зависимостей нет' },
    { affected: true, reason: 'Появляется опция конфига defaultDueDays со встроенным умолчанием 14 и документацией в README.', outcome: 'claim-1' },
    { affected: true, reason: 'Форма Invoice получает обязательное поле dueDays; bill и buildInvoice — необязательный пятый параметр.', outcome: 'claim-2' },
    { affected: false, reason: 'Значение видно в самом счёте; журналирование не требуется.', outcome: 'н/п — значение в результате' },
  ],
  changes: 'Нет изменений требований.',
  callerDecision: 'Вызывающие с прежним числом аргументов остаются законными: новый параметр необязателен, новое поле заполняется умолчанием.',
  prediction: 'Счёт получит обязательное dueDays с приоритетом явная опция → конфиг → 14, конфиг — опцию defaultDueDays, README — строку таблицы, тесты — проверку нового поведения.',
  ops: (path, card, _capability, { testPath, targetId }) => {
    if (path === 'src/config.ts') return [
      replaceDeclaration(path, card, 'BillingConfig', iface('BillingConfig', [{ name: 'currency', type: "'RUB'" }, { name: 'defaultDueDays', type: 'number' }]), targetId),
      replaceDeclaration(path, card, 'DEFAULT_CONFIG', constDecl('DEFAULT_CONFIG', obj({ currency: lit('RUB'), defaultDueDays: lit(14) }), { type: 'BillingConfig', export: true }), targetId),
    ];
    if (path === 'src/invoice.ts') return [
      replaceDeclaration(path, card, 'Invoice', iface('Invoice', [
        { name: 'number', type: 'string' }, { name: 'customer', type: 'Customer' }, { name: 'lines', type: 'readonly Line[]' },
        { name: 'subtotal', type: 'Kopeck' }, { name: 'total', type: 'Kopeck' }, { name: 'dueDays', type: 'number' },
      ]), targetId),
      replaceDeclaration(path, card, 'buildInvoice', fn('buildInvoice', [p('number', 'string'), p('customer', 'Customer'), p('lines', 'readonly Line[]'), p('config', 'Partial<BillingConfig>', true), p('opts', '{ dueDays?: number }', true)], [
        constDecl('resolved', call('resolveConfig', id('config'))),
        constDecl('sub', call('subtotal', id('lines'))),
        constDecl('dueDays', cond(logic('&&', notUndefined(id('opts')), notUndefined(prop(id('opts'), 'dueDays'))), prop(id('opts'), 'dueDays'), prop(id('resolved'), 'defaultDueDays'))),
        ret(obj({ number: id('number'), customer: id('customer'), lines: id('lines'), subtotal: id('sub'), total: id('sub'), dueDays: id('dueDays') })),
      ], { returnType: 'Invoice', export: true }), targetId),
    ];
    if (path === 'src/index.ts') return [
      replaceDeclaration(path, card, 'bill', fn('bill', [p('number', 'string'), p('customer', 'Customer'), p('lines', 'readonly Line[]'), p('config', 'Partial<BillingConfig>', true), p('opts', '{ dueDays?: number }', true)], [
        ret(call('buildInvoice', id('number'), id('customer'), id('lines'), id('config'), id('opts'))),
      ], { returnType: 'Invoice', export: true }), targetId),
    ];
    if (path === 'README.md') return [replaceText(path, card, '| `currency` | `RUB` | Валюта счетов. |', '| `currency` | `RUB` | Валюта счетов. |\n| `defaultDueDays` | `14` | Срок оплаты в днях по умолчанию; явная опция вызова `opts.dueDays` побеждает. |')];
    // Существующий тест формы счёта состоит из вызовов describe/it без объявлений: типизированные
    // операции v5 не имеют цели в этом файле. Книга честно не знает операции — это и есть находка.
    if (path === 'test/invoice.test.ts') return [];
    if (path === testPath) return [createModule(path, [
      imp('node:assert/strict', ['strictEqual']),
      imp('node:test', ['describe', 'it']),
      imp('../src/index.ts', ['bill']),
      constDecl('customer', customerLiteral('ivan@example.ru', '+79001234567')),
      describeBlock('срок оплаты по умолчанию', [
        { title: 'без конфига и опций — встроенные 14 дней', body: [assertCall('strictEqual', prop(call('bill', lit('СЧ-10'), id('customer'), billingLines()), 'dueDays'), lit(14))] },
        { title: 'конфиг площадки задаёт срок', body: [assertCall('strictEqual', prop(call('bill', lit('СЧ-11'), id('customer'), billingLines(), obj({ defaultDueDays: lit(30) })), 'dueDays'), lit(30))] },
        { title: 'явная опция вызова побеждает конфиг', body: [assertCall('strictEqual', prop(call('bill', lit('СЧ-12'), id('customer'), billingLines(), obj({ defaultDueDays: lit(30) }), obj({ dueDays: lit(7) })), 'dueDays'), lit(7))] },
      ]),
    ])];
    return null;
  },
};

// ---------------------------------------------------------------------------------------
// rename-field: Product.code → sku с совместимым чтением, README, новый тест.
// ---------------------------------------------------------------------------------------
const renameField: TaskSpec = {
  fixture: 'catalog',
  title: 'Артикул: code → sku',
  fields: {
    'название': 'Переименование поля артикула code → sku с совместимым чтением',
    'зачем': 'Приёмка и склад зовут артикул sku, каталог — code; одно поле под двумя именами путает в каждом разборе расхождений. Терминология приводится к приёмочной.',
    'коротко': 'Product получает sku вместо code; parse принимает и code, и sku (sku побеждает); serialize пишет только sku первым полем; README приводится к новому имени; существующие тесты зелёные без правки, добавлен тест совместимости.',
    'что делаем': 'Меняем Product и конструктор product(sku, title, priceK) в src/product.ts. В src/store.ts parse читает sku, а при его отсутствии code; при обоих — sku; serialize пишет {sku, title, priceK} без code. Таблицу формата README приводим к sku с пометкой, что code читается. Добавляем тест совместимости рядом с существующими и прогоняем набор командой проекта.',
    'чего не делаем': 'Не правим существующие тесты test/store.test.ts и test/product.test.ts; не меняем название, цену и формат файла (JSONL, строка на запись); не пишем code в вывод serialize.',
    'предположен': 'Внешние службы читают новые файлы по полю sku; старые файлы с code остаются читаемыми.',
    'инвариант': 'Round-trip parse(serialize(p)) сходится; существующие тесты зелёные без правки.',
    'остановиться': 'Если для зелёных существующих тестов потребуется их править — остановиться: формат сломан.',
  },
  lists: {},
  claims: [
    { procedure: 'Вызвать product("A-1", "Шуруп", 100) и прочитать поля записи.', expected: 'Запись {sku: "A-1", title: "Шуруп", priceK: 100} без поля code; проверки пустого артикула и цены сохранены.', scenario: 'product("A-1", "Шуруп", 100).sku === "A-1" и "code" in запись === false.', counterexample: 'Запись содержит code или не содержит sku.' },
    { procedure: 'Передать parse строки с {"code": …}, с {"sku": …} и с обоими именами.', expected: 'Все три читаются; при обоих именах артикул берётся из sku.', scenario: 'parse(\'{"code":"OLD","sku":"NEW","title":"T","priceK":1}\').sku === "NEW"; parse строки только с code даёт sku из code.', counterexample: 'Строка с code отвергается или при обоих именах побеждает code.' },
    { procedure: 'Вызвать serialize(product(...)) и разобрать строку как JSON.', expected: 'Ключи — sku, title, priceK в этом порядке; ключа code нет.', scenario: 'Object.keys(JSON.parse(serialize(p))) равно ["sku", "title", "priceK"].', counterexample: 'В строке есть code — как поле или дубль.' },
    { procedure: 'Запустить существующие тесты без правки.', expected: 'test/store.test.ts и test/product.test.ts зелёные без изменений; round-trip parse(serialize(p)) сходится.', scenario: 'node --test "test/**/*.test.ts" зелёный, diff существующих тестов пуст.', counterexample: 'Для зелёного набора потребовалось править существующий тест.' },
    { procedure: 'Добавить тест совместимости рядом с существующими и запустить набор командой проекта.', expected: 'Новый тест проверяет чтение старой строки, запись нового имени и победу sku при обоих именах; вывод команды идёт в журнал.', scenario: 'Новый файл в test/ зелёный вместе с остальными.', counterexample: 'Теста совместимости нет или он падает.' },
  ],
  research: {
    'src/product.ts': { fact: 'Product {code, title, priceK}; product(code, title, priceK) проверяет пустой артикул (RangeError) и целую неотрицательную цену (RangeError).', impact: 'Поле и параметр переименовываются в sku; проверки сохраняются.', change: 'Переименовать code → sku в Product и product().', reuse: 'Проверки конструктора переиспользуются parse без изменений.' },
    'src/store.ts': { fact: 'serialize пишет {code, title, priceK}; parse проверяет форму и читает r["code"], затем зовёт product(); saveAll/loadAll работают построчно.', impact: 'parse должен читать sku и code (sku побеждает), serialize — писать только sku первым полем.', change: 'Переписать serialize и parse под sku с совместимым чтением code.', reuse: null, risks: ['Запись обоих имён сломала бы внешние службы — пишется только sku.'] },
    'src/index.ts': { fact: 'Публичный контракт: product, Product, loadAll, parse, saveAll, serialize.', impact: 'Имена экспортов не меняются.', change: null, reuse: null },
    'README.md': { fact: 'Таблица «Формат строки каталога» описывает поля code, title, priceK и порядок полей.', impact: 'Строка code приводится к sku с пометкой о чтении старого имени.', change: 'Заменить строку таблицы code на sku с пометкой о совместимости.', reuse: null },
    'test/store.test.ts': { fact: 'Round-trip parse(serialize) и отказы parse на литералах с code; тесты не сверяют имя поля.', impact: 'Остаются зелёными без правки: литералы с code читаются через совместимость.', change: null, reuse: null },
    'test/product.test.ts': { fact: 'Тесты конструктора product на проверки пустого артикула и цены.', impact: 'Без правки, зелёные.', change: null, reuse: null },
  },
  defaultTestPath: 'test/sku.test.ts',
  cards: testPath => [
    { file: 'src/product.ts', claims: [1], dependsOn: [], symbol: 'Product',
      action: 'Переименовать поле code в sku в интерфейсе Product и в конструкторе product(sku, title, priceK), сохранив проверки пустого артикула и цены.',
      check: 'Вызвать product("A-1", "Шуруп", 100) и product("", "Шуруп", 100).', expected: 'Запись {sku, title, priceK} без code; пустой артикул бросает RangeError.',
      contract: 'Product меняет имя поля code → sku; потребитель store.ts обновляется в этом же витке.' },
    { file: 'src/store.ts', claims: [2, 3, 4], dependsOn: [1], symbol: 'parse',
      action: 'parse читает артикул из sku, а при его отсутствии из code (sku побеждает); serialize пишет {sku, title, priceK} без code.',
      check: 'Разобрать строки с code, с sku и с обоими; сериализовать запись и прочитать ключи.', expected: 'Все три строки читаются, при обоих побеждает sku; в выводе ключи sku, title, priceK без code.',
      contract: 'Формат записи меняет имя поля на sku; чтение старого имени сохранено для совместимости.' },
    { file: 'README.md', claims: [3], dependsOn: [2], symbol: 'README', isNew: true,
      action: 'Привести строку code таблицы формата к sku и отметить, что старое имя читается.',
      check: 'Прочитать README.md.', expected: 'Таблица формата содержит sku и пометку о чтении code.',
      contract: 'н/п — документация.' },
    { file: testPath, claims: [5], dependsOn: [2], symbol: 'skuCompatibilityTests', isNew: true,
      action: 'Написать тест совместимости: старая строка с code читается, новая пишется только с sku первым полем, при обоих именах побеждает sku.',
      check: 'Запустить node --test "test/**/*.test.ts" и прочитать вывод.', expected: 'Новый тест зелёный вместе с существующими без их правки.',
      contract: 'н/п — тест.' },
  ],
  approach: 'Переименование проводится в типе и конструкторе (src/product.ts:Product, product), чтение делается совместимым в src/store.ts:parse (sku, иначе code; sku побеждает), запись — только новым именем в src/store.ts:serialize; README документирует новое имя. Альтернатива — писать оба имени — отвергнута: внешние службы прочитают строку по-разному.',
  excluded: ['Не править test/store.test.ts и test/product.test.ts', 'Не писать code в вывод serialize', 'Не менять название, цену и формат JSONL'],
  axes: [
    { affected: false, reason: 'Данные те же, новых внешних входов нет.', outcome: 'н/п — нет новых входов' },
    { affected: false, reason: 'Одно дополнительное чтение ключа при разборе строки.', outcome: 'н/п — константная стоимость' },
    { affected: false, reason: 'Внешних зависимостей нет.', outcome: 'н/п — зависимостей нет' },
    { affected: false, reason: 'Настроек формат не имеет.', outcome: 'н/п — настроек нет' },
    { affected: true, reason: 'Публичный формат строки меняет имя поля; старые файлы читаются через совместимость, новые пишутся только с sku.', outcome: 'claim-2' },
    { affected: false, reason: 'Ошибки разбора по-прежнему называют причину в исключении.', outcome: 'н/п — диагностика в исключениях сохранена' },
  ],
  changes: 'Нет изменений требований.',
  callerDecision: 'Вызывающие собирают записи конструктором и сверяют round-trip, имя поля не читают напрямую; совместимость сохранена чтением обоих имён.',
  prediction: 'Запись получит поле sku вместо code, parse станет читать оба имени с приоритетом sku, serialize — писать только sku первым полем, README и новый тест зафиксируют совместимость.',
  ops: (path, card, _capability, { testPath, targetId }) => {
    if (path === 'src/product.ts') return [
      replaceDeclaration(path, card, 'Product', iface('Product', [{ name: 'sku', type: 'string' }, { name: 'title', type: 'string' }, { name: 'priceK', type: 'number' }]), targetId),
      replaceDeclaration(path, card, 'product', fn('product', [p('sku', 'string'), p('title', 'string'), p('priceK', 'number')], [
        iff(bin('===', call(prop(id('sku'), 'trim')), lit('')), thr('RangeError', lit('артикул товара пуст'))),
        iff(logic('||', not(call('Number.isInteger', id('priceK'))), bin('<', id('priceK'), lit(0))), thr('RangeError', concat('цена в копейках — целое неотрицательное число, получено ', id('priceK')))),
        ret(obj({ sku: id('sku'), title: id('title'), priceK: id('priceK') })),
      ], { returnType: 'Product', export: true }), targetId),
    ];
    if (path === 'src/store.ts') return [
      replaceDeclaration(path, card, 'serialize', fn('serialize', [p('p', 'Product')], [
        ret(call('JSON.stringify', obj({ sku: prop(id('p'), 'sku'), title: prop(id('p'), 'title'), priceK: prop(id('p'), 'priceK') }))),
      ], { returnType: 'string', export: true }), targetId),
      // try/catch в IR не представим: SyntaxError от JSON.parse пробрасывается как есть.
      replaceDeclaration(path, card, 'parse', fn('parse', [p('line', 'string')], [
        constDecl('raw', call('JSON.parse', id('line'))),
        iff(logic('||', logic('||', bin('!==', typeofE(id('raw')), lit('object')), bin('===', id('raw'), lit(null))), call('Array.isArray', id('raw'))), thr('TypeError', lit('строка каталога — не объект'))),
        constDecl('sku', cond(notUndefined(index(id('raw'), lit('sku'))), index(id('raw'), lit('sku')), index(id('raw'), lit('code')))),
        constDecl('title', index(id('raw'), lit('title'))),
        constDecl('priceK', index(id('raw'), lit('priceK'))),
        iff(bin('!==', typeofE(id('sku')), lit('string')), thr('TypeError', lit('в строке каталога нет артикула (sku или code)'))),
        iff(bin('!==', typeofE(id('title')), lit('string')), thr('TypeError', lit('в строке каталога нет названия (title)'))),
        iff(bin('!==', typeofE(id('priceK')), lit('number')), thr('TypeError', lit('в строке каталога нет цены (priceK)'))),
        ret(call('product', id('sku'), id('title'), id('priceK'))),
      ], { returnType: 'Product', export: true }), targetId),
    ];
    if (path === 'README.md') return [replaceText(path, card, '| `code` | строка | Артикул — идентификатор записи. Непустой. |', '| `sku` | строка | Артикул — идентификатор записи. Непустой. Старое имя `code` при чтении принимается; если в строке оба имени, побеждает `sku`. |')];
    if (path === testPath) return [createModule(path, [
      imp('node:assert/strict', ['deepStrictEqual', 'strictEqual']),
      imp('node:test', ['describe', 'it']),
      imp('../src/index.ts', ['parse', 'product', 'serialize']),
      describeBlock('совместимость артикула code → sku', [
        { title: 'старая строка с code читается', body: [assertCall('strictEqual', prop(call('parse', lit('{"code":"A-1","title":"Шуруп","priceK":100}')), 'sku'), lit('A-1'))] },
        { title: 'новая строка пишется только с sku, и sku идёт первым', body: [
          constDecl('row', call('JSON.parse', call('serialize', call('product', lit('A-1'), lit('Шуруп'), lit(100))))),
          assertCall('strictEqual', bin('in', lit('code'), id('row')), lit(false)),
          assertCall('deepStrictEqual', call('Object.keys', id('row')), arr(lit('sku'), lit('title'), lit('priceK'))),
        ] },
        { title: 'при обоих именах побеждает sku', body: [assertCall('strictEqual', prop(call('parse', lit('{"code":"OLD","sku":"NEW","title":"Шуруп","priceK":100}')), 'sku'), lit('NEW'))] },
      ]),
    ])];
    return null;
  },
};

// ---------------------------------------------------------------------------------------
// idempotent-retry: ключ идемпотентности в sendNotification, Map в модуле, новый тест.
// ---------------------------------------------------------------------------------------
const message = (to: string, text: string): E => obj({ to: lit(to), text: lit(text) });
const idempotentRetry: TaskSpec = {
  fixture: 'notify',
  title: 'Идемпотентная отправка',
  fields: {
    'название': 'Идемпотентная отправка уведомлений по ключу',
    'зачем': 'Вызывающая сторона ретраит по таймауту, и каждый вызов честно уходит в транспорт — человек получает одно уведомление дважды. Ключ идемпотентности делает повтор безопасным.',
    'коротко': 'sendNotification(transport, msg, opts?) принимает необязательные опции {idempotencyKey?}; повтор с тем же ключом не отправляет и возвращает прежний id; тот же ключ с другим телом — исключение; без ключа — как раньше; хранилище — Map в модуле отправки; новый тест.',
    'что делаем': 'Добавляем третий необязательный параметр opts: {idempotencyKey?: string} в sendNotification (src/sender.ts). Ведём Map ключ → {id, отпечаток тела} в модуле отправки. Повтор с тем же ключом и тем же телом возвращает прежний id без отправки; с другим телом (to, text или phone) бросает исключение; вызов без ключа отправляет всегда. Пишем тест рядом с существующими и прогоняем набор командой проекта.',
    'чего не делаем': 'Не трогаем src/transport.ts и memoryTransport; не правим существующие тесты; не делаем TTL и очистку хранилища; внешних зависимостей не добавляем.',
    'предположен': 'Время жизни ключа — процесс; сравнение тела — по полям to, text, phone.',
    'инвариант': 'Транспорт про ключи не знает; вызовы с двумя аргументами остаются законными.',
    'остановиться': 'Если потребуется менять транспорт или существующие тесты — остановиться и спросить.',
  },
  lists: {},
  claims: [
    { procedure: 'Вызвать sendNotification дважды с одним ключом и одним сообщением на memoryTransport.', expected: 'Второй вызов возвращает id первого и не добавляет записи в transport.sent.', scenario: 'first.id === second.id и t.sent.length === 1 при одинаковом idempotencyKey.', counterexample: 'Второй вызов отправляет снова или возвращает новый id.' },
    { procedure: 'Вызвать sendNotification двумя аргументами с одинаковыми сообщениями дважды.', expected: 'Оба вызова уходят в транспорт; существующие тесты зелёные без правки.', scenario: 'Без ключа t.sent.length === 2 при двух одинаковых вызовах.', counterexample: 'Вызов без ключа дедуплицируется или двухаргументный вызов перестал компилироваться.' },
    { procedure: 'Вызвать sendNotification с тем же ключом, но другим to, text или phone.', expected: 'Бросается исключение; повторной отправки и возврата чужого id нет.', scenario: 'throws(() => sendNotification(t, otherMsg, {idempotencyKey: sameKey})).', counterexample: 'Другое тело под тем же ключом тихо отправляется или возвращает прежний id.' },
    { procedure: 'Прочитать src/sender.ts и package.json.', expected: 'Хранилище — Map в модуле отправки (или новом модуле src/); зависимостей не добавлено; транспорт не изменён.', scenario: 'В src/sender.ts объявлен Map ключей; src/transport.ts без diff.', counterexample: 'Ключи хранятся в транспорте или добавлена внешняя зависимость.' },
    { procedure: 'Запустить node --test "test/**/*.test.ts" командой проекта и прочитать вывод.', expected: 'Новый тест идемпотентности зелёный вместе с существующими; вывод команды в журнале.', scenario: 'Новый файл в test/ покрывает повтор, другое тело и вызов без ключа.', counterexample: 'Тест отсутствует или набор красный.' },
  ],
  research: {
    'src/sender.ts': { fact: 'sendNotification(transport, msg) — тонкая обёртка: возвращает {id: transport.send(msg)}; правила отправки по замыслу живут здесь.', impact: 'Сюда добавляются необязательные опции с ключом и Map ключ → {id, отпечаток}.', change: 'Добавить opts?: {idempotencyKey?} и Map хранилище ключей в модуле.', reuse: 'Место для правил отправки уже выделено этим модулем.' },
    'src/transport.ts': { fact: 'Transport.send(msg) возвращает id; memoryTransport — стенд с массивом sent и счётчиком mem-N.', impact: 'Не меняется: идемпотентность — забота отправителя.', change: null, reuse: 'memoryTransport используется новым тестом как стенд.', risks: ['Транспорт менять запрещено рамками задачи.'] },
    'src/message.ts': { fact: 'OutMessage {to, text, phone?} — форма уведомления отдельно от транспорта.', impact: 'Отпечаток тела считается по этим трём полям.', change: null, reuse: null },
    'src/index.ts': { fact: 'Публичный контракт реэкспортирует sendNotification, memoryTransport, outbox и журнал.', impact: 'Имена экспортов не меняются.', change: null, reuse: null },
    'test/sender.test.ts': { fact: 'Существующие тесты вызывают sendNotification двумя аргументами и сверяют доставку и id.', impact: 'Остаются зелёными без правки: третий параметр необязателен.', change: null, reuse: null },
  },
  defaultTestPath: 'test/idempotency.test.ts',
  cards: testPath => [
    { file: 'src/sender.ts', claims: [1, 2, 3, 4], dependsOn: [], symbol: 'sendNotification',
      action: 'Добавить третий необязательный параметр opts {idempotencyKey?} и Map ключ → {id, отпечаток тела}: повтор с тем же ключом и телом возвращает прежний id без отправки, другое тело под тем же ключом бросает Error, без ключа — отправка как раньше.',
      check: 'На memoryTransport вызвать с одним ключом дважды, с тем же ключом и другим телом, и дважды без ключа.', expected: 'Один sent и одинаковый id; исключение без отправки; два sent соответственно.',
      contract: 'sendNotification получает необязательный третий параметр; двухаргументные вызовы законны и ведут себя как раньше.' },
    { file: testPath, claims: [5], dependsOn: [1], symbol: 'idempotencyTests', isNew: true,
      action: 'Написать тест повтора с ключом, другого тела под тем же ключом и вызова без ключа на memoryTransport.',
      check: 'Запустить node --test "test/**/*.test.ts" и прочитать вывод.', expected: 'Новый тест зелёный вместе с существующими.',
      contract: 'н/п — тест.' },
  ],
  approach: 'Ключ идемпотентности обрабатывается в отправителе (src/sender.ts:sendNotification) с Map в этом же модуле; транспорт (src/transport.ts) не меняется. Альтернатива — дедупликация в транспорте — отвергнута рамками задачи.',
  excluded: ['Не трогать src/transport.ts', 'Не править существующие тесты', 'Не делать TTL и очистку хранилища', 'Не добавлять зависимости'],
  axes: [
    { affected: false, reason: 'Ключ — строка вызывающего; персональные данные в журнал не пишутся, хранится только отпечаток и id.', outcome: 'н/п — новых каналов утечки нет' },
    { affected: true, reason: 'Map растёт на ключ за процесс; TTL и очистка явно вынесены за рамки витка.', outcome: 'следующий виток — очистка хранилища ключей' },
    { affected: false, reason: 'Внешних зависимостей нет.', outcome: 'н/п — зависимостей нет' },
    { affected: false, reason: 'Настроек не добавляется.', outcome: 'н/п — настроек нет' },
    { affected: true, reason: 'Сигнатура sendNotification расширяется необязательным параметром; прежние вызовы совместимы.', outcome: 'claim-2' },
    { affected: false, reason: 'Ошибка повтора с другим телом поднимается исключением вызывающему.', outcome: 'н/п — ошибка возвращается явно' },
  ],
  changes: 'Нет изменений требований.',
  callerDecision: 'Вызывающие с двумя аргументами остаются законными: третий параметр необязателен и без него поведение прежнее.',
  prediction: 'sendNotification примет необязательный ключ идемпотентности, повтор с тем же ключом вернёт прежний id без отправки, другое тело под ключом бросит исключение; новый тест это зафиксирует.',
  ops: (path, card, _capability, { testPath, targetId }) => {
    if (path === 'src/sender.ts') return [
      insertBefore(path, 'sendNotification', [
        iface('SendOptions', [{ name: 'idempotencyKey', type: 'string', optional: true }]),
        constDecl('sentByKey', make('Map'), { type: 'Map<string, { result: { id: string }; fingerprint: string }>' }),
      ]),
      replaceDeclaration(path, card, 'sendNotification', fn('sendNotification', [p('transport', 'Transport'), p('msg', 'OutMessage'), p('opts', 'SendOptions', true)], [
        constDecl('key', cond(notUndefined(id('opts')), prop(id('opts'), 'idempotencyKey'), undef())),
        iff(isUndefined(id('key')), ret(obj({ id: call(prop(id('transport'), 'send'), id('msg')) }))),
        constDecl('fingerprint', call('JSON.stringify', arr(prop(id('msg'), 'to'), prop(id('msg'), 'text'), cond(isUndefined(prop(id('msg'), 'phone')), lit(null), prop(id('msg'), 'phone'))))),
        constDecl('previous', call(prop(id('sentByKey'), 'get'), id('key'))),
        iff(logic('&&', notUndefined(id('previous')), bin('!==', prop(id('previous'), 'fingerprint'), id('fingerprint'))), thr('Error', concat('ключ идемпотентности ', id('key'), ' уже использован с другим сообщением'))),
        // Повтор возвращает тот же объект результата, а не копию: «прежний результат» в контракте
        // читается и как идентичность значения, и это дешевле, чем спорить о форме равенства.
        iff(notUndefined(id('previous')), ret(prop(id('previous'), 'result'))),
        constDecl('result', obj({ id: call(prop(id('transport'), 'send'), id('msg')) })),
        expr(call(prop(id('sentByKey'), 'set'), id('key'), obj({ result: id('result'), fingerprint: id('fingerprint') }))),
        ret(id('result')),
      ], { returnType: '{ id: string }', export: true }), targetId),
    ];
    if (path === testPath) return [createModule(path, [
      imp('node:assert/strict', ['strictEqual', 'throws']),
      imp('node:test', ['describe', 'it']),
      imp('../src/index.ts', ['memoryTransport', 'sendNotification']),
      describeBlock('идемпотентная отправка', [
        { title: 'повтор с тем же ключом не отправляет повторно и возвращает прежний id', body: [
          constDecl('t', call('memoryTransport')),
          constDecl('msg', message('anna@example.ru', 'Заказ собран')),
          constDecl('first', call('sendNotification', id('t'), id('msg'), obj({ idempotencyKey: lit('order-1-collected') }))),
          constDecl('second', call('sendNotification', id('t'), id('msg'), obj({ idempotencyKey: lit('order-1-collected') }))),
          assertCall('strictEqual', prop(id('second'), 'id'), prop(id('first'), 'id')),
          assertCall('strictEqual', prop(prop(id('t'), 'sent'), 'length'), lit(1)),
        ] },
        { title: 'тот же ключ с другим телом — исключение без отправки', body: [
          constDecl('t', call('memoryTransport')),
          expr(call('sendNotification', id('t'), message('anna@example.ru', 'Заказ собран'), obj({ idempotencyKey: lit('order-2-collected') }))),
          assertCall('throws', arrow([], call('sendNotification', id('t'), message('anna@example.ru', 'Заказ выдан'), obj({ idempotencyKey: lit('order-2-collected') })))),
          assertCall('strictEqual', prop(prop(id('t'), 'sent'), 'length'), lit(1)),
        ] },
        { title: 'без ключа отправляется всегда, даже одинаковое сообщение', body: [
          constDecl('t', call('memoryTransport')),
          constDecl('msg', message('anna@example.ru', 'Заказ собран')),
          expr(call('sendNotification', id('t'), id('msg'))),
          expr(call('sendNotification', id('t'), id('msg'))),
          assertCall('strictEqual', prop(prop(id('t'), 'sent'), 'length'), lit(2)),
        ] },
      ]),
    ])];
    return null;
  },
};

// ---------------------------------------------------------------------------------------
// vat-rounding: НДС отдельным модулем, opts.vat, поле vat только у облагаемого счёта,
// льготная ставка — вопрос человеку (правило не записано в репозитории).
// ---------------------------------------------------------------------------------------
const vatRounding: TaskSpec = {
  fixture: 'billing',
  title: 'НДС в счёте',
  fields: {
    'название': 'НДС в счёте: стандартная и льготная ставка отдельным модулем',
    'зачем': 'Счета уходят без налога: позиции и подытог есть, а НДС не выделен. Облагаемый счёт должен показывать налог отдельным полем и включать его в итог.',
    'коротко': 'bill/buildInvoice принимают opts пятым параметром с opts.vat: "std" | "none" (умолчание none); для std в Invoice добавляется vat и total = подытог + налог; для none форма прежняя без vat; правило расчёта — в src/vat.ts через percent; новый тест, существующие без правки.',
    'что делаем': 'Добавляем пятый параметр opts?: {vat?: "std" | "none"} в buildInvoice (src/invoice.ts) и bill (src/index.ts). Правило налога выносим в src/vat.ts: стандартная ставка 20% через percent из money.ts; льготная ставка — по ответу человека (значение и условие в репозитории не записаны). Для std счёт получает поле vat и total = subtotal + vat; для none объект остаётся прежней формы. Пишем тест рядом с существующими и прогоняем набор командой проекта.',
    'чего не делаем': 'Не меняем src/money.ts и src/customer.ts; не правим существующие тесты; не заводим своё округление; не меняем единицы (копейки) и порядок расчёта.',
    'предположен': 'Необлагаемый счёт — умолчание; льготная ставка применяется по правилу, полученному от человека.',
    'инвариант': 'Округление — только percent из money.ts (половина вверх); форма необлагаемого счёта не меняется.',
    'остановиться': 'Значение льготной ставки и условие её применения не записаны в репозитории — спросить человека до реализации.',
  },
  lists: {},
  claims: [
    { procedure: 'Вызвать bill без opts, с opts {vat: "none"} и с opts {vat: "std"}; прочитать поля счёта.', expected: 'Без opts и при none — форма {number, customer, lines, subtotal, total} без vat и total === subtotal; при std — поле vat и total === subtotal + vat.', scenario: '"vat" in bill(..., undefined, {vat: "std"}) === true; "vat" in bill(...) === false.', counterexample: 'Необлагаемый счёт получает vat: 0 или облагаемый не включает налог в total.' },
    { procedure: 'Прочитать src/vat.ts и src/invoice.ts.', expected: 'Правило ставки и расчёт налога живут в src/vat.ts; invoice.ts лишь вызывает его.', scenario: 'src/vat.ts экспортирует функцию расчёта налога, импортируемую buildInvoice.', counterexample: 'Проценты и правило ставки зашиты в buildInvoice.' },
    { procedure: 'Запустить node --test "test/**/*.test.ts" командой проекта и прочитать вывод.', expected: 'Новый тест правила НДС зелёный вместе с существующими; вывод команды в журнале.', scenario: 'Новый файл в test/ проверяет стандартную ставку с округлением и форму необлагаемого счёта.', counterexample: 'Теста нет или набор красный.' },
    { procedure: 'Сравнить diff test/ с базой.', expected: 'test/invoice.test.ts, test/money.test.ts, test/lines.test.ts не изменены и зелёные.', scenario: 'Существующие тесты без правки зелёные: необлагаемый счёт сохранил пять полей.', counterexample: 'Для зелёного набора потребовалось править существующий тест.' },
  ],
  research: {
    'src/invoice.ts': { fact: 'Invoice {number, customer, lines, subtotal, total}; buildInvoice(number, customer, lines, config?) считает подытог через subtotal; налогов нет, total === subtotal.', impact: 'Нужен пятый параметр opts с vat, необязательное поле vat и total с налогом только для std; порядок слагаемых подытог → налог → итог.', change: 'Добавить opts?: {vat?: "std" | "none"} и ветку облагаемого счёта с полем vat.', reuse: 'subtotal и resolveConfig используются как есть.' },
    'src/money.ts': { fact: 'percent(amount, pct) округляет половину вверх — единственное правило округления пакета.', impact: 'Налог считается через percent; своего округления не заводится.', change: null, reuse: 'percent для расчёта налога.' },
    'src/lines.ts': { fact: 'Line {title, qty, priceK}; subtotal — сумма по позициям без налогов и скидок.', impact: 'Признак льготной позиции, если потребуется правилом, добавляется сюда необязательным полем.', change: 'Добавить необязательный признак льготной позиции reduced?: boolean.', reuse: null },
    'src/index.ts': { fact: 'Публичный bill(number, customer, lines, config?) делегирует buildInvoice.', impact: 'bill получает пятый параметр opts и передаёт его дальше.', change: 'Расширить bill параметром opts?: {vat?: "std" | "none"}.', reuse: null },
    'src/config.ts': { fact: 'BillingConfig {currency}, resolveConfig.', impact: 'Не меняется.', change: null, reuse: null },
    'src/customer.ts': { fact: 'Customer {name, email, phone}.', impact: 'Не меняется.', change: null, reuse: null },
    'README.md': { fact: 'README описывает модули, копейки и закреплённый порядок расчёта: подытог → слагаемые отдельными полями → итог; про льготную ставку НДС не сказано.', impact: 'Порядок полей облагаемого счёта следует README; значение льготной ставки документом не задано.', change: null, reuse: null },
    'test/invoice.test.ts': { fact: 'Тест формы счёта сверяет ровно пять ключей необлагаемого счёта.', impact: 'Необлагаемый счёт обязан сохранить форму без vat — иначе тест упадёт.', change: null, reuse: null },
  },
  humanQuestion: {
    askOn: 'src/invoice.ts',
    question: 'Какова льготная ставка НДС и при каком условии она применяется к счёту: когда все позиции льготные или когда хотя бы одна?',
    missingDecision: 'Значение льготной ставки НДС и условие её применения к счёту',
    options: ['Льготная ставка применяется, если все позиции счёта льготные; смешанный счёт — по стандартной ставке', 'Льготная ставка применяется построчно к льготным позициям, остальные — по стандартной'],
    consequence: 'Без решения налог льготного счёта считается неверно; значение и условие нельзя вывести из кода, README и текста задачи.',
    resolves: { claim: 2, kind: 'уточняет', text: 'правило ставки в src/vat.ts: 20% стандарт, 10% льгота только когда все позиции льготные; смешанный счёт — по стандартной ставке' },
  },
  defaultTestPath: 'test/vat.test.ts',
  cards: testPath => [
    { file: 'src/lines.ts', claims: [2], dependsOn: [], symbol: 'Line',
      action: 'Добавить в Line необязательный признак льготной позиции reduced?: boolean; lineTotal и subtotal без изменений.',
      check: 'Собрать позицию с reduced: true и без него; посчитать subtotal.', expected: 'Подытог не меняется; признак доступен правилу ставки.',
      contract: 'Line расширяется необязательным полем; прежние литералы позиций законны.' },
    { file: 'src/vat.ts', claims: [2], dependsOn: [1], symbol: 'vatAmount', isNew: true,
      action: 'Создать модуль правила НДС: ставка 20%, льготная 10% только если все позиции reduced, смешанный счёт — 20%; налог считается через percent из money.ts.',
      check: 'Вызвать vatAmount(1003, обычные позиции) и vatAmount(1000, все льготные).', expected: '201 (половина вверх) и 100 соответственно.',
      contract: 'Новый экспорт vatAmount(subtotal, lines); своего округления нет.' },
    { file: 'src/invoice.ts', claims: [1, 2], dependsOn: [2], symbol: 'buildInvoice',
      action: 'Добавить opts?: {vat?: "std" | "none"} пятым параметром; при std добавить поле vat = vatAmount(sub, lines) и total = sub + vat; при none вернуть прежнюю форму без vat.',
      check: 'Собрать счёт без opts, с vat none и с vat std.', expected: 'Первые два — пять полей и total === subtotal; третий — поле vat и total === subtotal + vat.',
      contract: 'Invoice получает необязательное поле vat; buildInvoice — необязательный пятый параметр; прежние вызовы совместимы.' },
    { file: 'src/index.ts', claims: [1], dependsOn: [3], symbol: 'bill',
      action: 'Расширить bill(number, customer, lines, config?, opts?) и передать opts в buildInvoice.',
      check: 'Вызвать bill с opts {vat: "std"}.', expected: 'Счёт облагаемый, с полем vat; четырёхаргументные вызовы работают как раньше.',
      contract: 'Публичный bill получает необязательный пятый параметр.' },
    { file: testPath, claims: [3, 4], dependsOn: [3, 4], symbol: 'vatTests', isNew: true,
      action: 'Написать тест: необлагаемый счёт без vat, стандартная ставка 20% с округлением половины вверх, льготная 10% при всех льготных позициях и 20% для смешанного.',
      check: 'Запустить node --test "test/**/*.test.ts" и прочитать вывод.', expected: 'Новый тест зелёный вместе с существующими без их правки.',
      contract: 'н/п — тест.' },
  ],
  approach: 'Правило налога вынесено в src/vat.ts:vatAmount (20% стандарт, 10% льгота при всех льготных позициях — по ответу человека) с округлением через src/money.ts:percent; src/invoice.ts:buildInvoice добавляет vat и total только для opts.vat = std, сохраняя форму необлагаемого счёта; src/index.ts:bill передаёт opts. Альтернатива — vat: 0 у необлагаемого — сломала бы существующий тест формы.',
  excluded: ['Не менять src/money.ts и src/customer.ts', 'Не править существующие тесты', 'Не заводить своё округление', 'Не менять единицы и порядок расчёта'],
  axes: [
    { affected: false, reason: 'Новых внешних входов нет: ставка выбирается по данным позиций.', outcome: 'н/п — нет новых входов' },
    { affected: false, reason: 'Один проход по позициям для признака льготы и один вызов percent.', outcome: 'н/п — линейная стоимость по позициям' },
    { affected: false, reason: 'Внешних зависимостей нет.', outcome: 'н/п — зависимостей нет' },
    { affected: false, reason: 'Режим налога задаётся опцией вызова, а не конфигом площадки.', outcome: 'н/п — настроек не добавляется' },
    { affected: true, reason: 'Invoice получает необязательное поле vat, bill и buildInvoice — необязательный параметр; необлагаемый счёт сохраняет прежнюю форму.', outcome: 'claim-1' },
    { affected: false, reason: 'Налог виден отдельным полем счёта.', outcome: 'н/п — значение в результате' },
  ],
  changes: 'Уточнение от человека: льготная ставка 10% применяется, только если все позиции льготные (reduced: true); смешанный счёт — 20%; третьего значения opts.vat не требуется.',
  callerDecision: 'Вызывающие с прежним числом аргументов получают необлагаемый счёт прежней формы.',
  prediction: 'Облагаемый счёт получит поле vat (20%, либо 10% при всех льготных позициях) и total с налогом, необлагаемый сохранит прежнюю форму; правило живёт в src/vat.ts и покрыто новым тестом.',
  ops: (path, card, _capability, { testPath, targetId }) => {
    if (path === 'src/lines.ts') return [
      replaceDeclaration(path, card, 'Line', iface('Line', [{ name: 'title', type: 'string' }, { name: 'qty', type: 'number' }, { name: 'priceK', type: 'Kopeck' }, { name: 'reduced', type: 'boolean', optional: true }]), targetId),
    ];
    if (path === 'src/vat.ts') return [createModule(path, [
      imp('./money.ts', ['Kopeck'], true),
      imp('./money.ts', ['percent']),
      imp('./lines.ts', ['Line'], true),
      typeAlias('VatMode', "'std' | 'none'"),
      constDecl('STANDARD_VAT_PERCENT', lit(20), { export: true }),
      constDecl('REDUCED_VAT_PERCENT', lit(10), { export: true }),
      fn('vatPercent', [p('lines', 'readonly Line[]')], [
        iff(logic('&&', bin('>', prop(id('lines'), 'length'), lit(0)), call(prop(id('lines'), 'every'), arrow([p('line')], bin('===', prop(id('line'), 'reduced'), lit(true))))), ret(id('REDUCED_VAT_PERCENT'))),
        ret(id('STANDARD_VAT_PERCENT')),
      ], { returnType: 'number', export: true }),
      fn('vatAmount', [p('sub', 'Kopeck'), p('lines', 'readonly Line[]')], [
        ret(call('percent', id('sub'), call('vatPercent', id('lines')))),
      ], { returnType: 'Kopeck', export: true }),
    ])];
    if (path === 'src/invoice.ts') return [
      { op: 'ensure_import', file: path, from: './vat.ts', names: ['vatAmount'] },
      replaceDeclaration(path, card, 'Invoice', iface('Invoice', [
        { name: 'number', type: 'string' }, { name: 'customer', type: 'Customer' }, { name: 'lines', type: 'readonly Line[]' },
        { name: 'subtotal', type: 'Kopeck' }, { name: 'vat', type: 'Kopeck', optional: true }, { name: 'total', type: 'Kopeck' },
      ]), targetId),
      replaceDeclaration(path, card, 'buildInvoice', fn('buildInvoice', [p('number', 'string'), p('customer', 'Customer'), p('lines', 'readonly Line[]'), p('config', 'Partial<BillingConfig>', true), p('opts', "{ vat?: 'std' | 'none' }", true)], [
        expr(call('resolveConfig', id('config'))),
        constDecl('sub', call('subtotal', id('lines'))),
        constDecl('mode', cond(logic('&&', notUndefined(id('opts')), notUndefined(prop(id('opts'), 'vat'))), prop(id('opts'), 'vat'), lit('none'))),
        iff(bin('===', id('mode'), lit('none')), ret(obj({ number: id('number'), customer: id('customer'), lines: id('lines'), subtotal: id('sub'), total: id('sub') }))),
        constDecl('vat', call('vatAmount', id('sub'), id('lines'))),
        ret(obj({ number: id('number'), customer: id('customer'), lines: id('lines'), subtotal: id('sub'), vat: id('vat'), total: bin('+', id('sub'), id('vat')) })),
      ], { returnType: 'Invoice', export: true }), targetId),
    ];
    if (path === 'src/index.ts') return [
      replaceDeclaration(path, card, 'bill', fn('bill', [p('number', 'string'), p('customer', 'Customer'), p('lines', 'readonly Line[]'), p('config', 'Partial<BillingConfig>', true), p('opts', "{ vat?: 'std' | 'none' }", true)], [
        ret(call('buildInvoice', id('number'), id('customer'), id('lines'), id('config'), id('opts'))),
      ], { returnType: 'Invoice', export: true }), targetId),
    ];
    if (path === testPath) return [createModule(path, [
      imp('node:assert/strict', ['strictEqual']),
      imp('node:test', ['describe', 'it']),
      imp('../src/index.ts', ['bill']),
      constDecl('customer', customerLiteral('ivan@example.ru', '+79001234567')),
      describeBlock('НДС в счёте', [
        { title: 'необлагаемый счёт — прежняя форма без поля vat', body: [
          constDecl('inv', call('bill', lit('СЧ-20'), id('customer'), arr(obj({ title: lit('Пакет'), qty: lit(1), priceK: lit(1003) })))),
          assertCall('strictEqual', bin('in', lit('vat'), id('inv')), lit(false)),
          assertCall('strictEqual', prop(id('inv'), 'total'), lit(1003)),
        ] },
        { title: 'стандартная ставка 20% с округлением половины вверх', body: [
          constDecl('inv', call('bill', lit('СЧ-21'), id('customer'), arr(obj({ title: lit('Пакет'), qty: lit(1), priceK: lit(1003) })), undef(), obj({ vat: lit('std') }))),
          assertCall('strictEqual', prop(id('inv'), 'vat'), lit(201)),
          assertCall('strictEqual', prop(id('inv'), 'total'), lit(1204)),
        ] },
        { title: 'льготная ставка 10% только если все позиции льготные; смешанный счёт — 20%', body: [
          constDecl('reduced', call('bill', lit('СЧ-22'), id('customer'), arr(obj({ title: lit('Хлеб'), qty: lit(2), priceK: lit(500), reduced: lit(true) })), undef(), obj({ vat: lit('std') }))),
          assertCall('strictEqual', prop(id('reduced'), 'vat'), lit(100)),
          constDecl('mixed', call('bill', lit('СЧ-23'), id('customer'), arr(obj({ title: lit('Хлеб'), qty: lit(1), priceK: lit(500), reduced: lit(true) }), obj({ title: lit('Пакет'), qty: lit(1), priceK: lit(500) })), undef(), obj({ vat: lit('std') }))),
          assertCall('strictEqual', prop(id('mixed'), 'vat'), lit(200)),
        ] },
      ]),
    ])];
    return null;
  },
};

export const ORACLE_BOOKS: Record<string, OracleBook> = {
  'add-validator': new Book('add-validator', addValidator),
  'config-default': new Book('config-default', configDefault),
  'rename-field': new Book('rename-field', renameField),
  'idempotent-retry': new Book('idempotent-retry', idempotentRetry),
  'vat-rounding': new Book('vat-rounding', vatRounding),
};
