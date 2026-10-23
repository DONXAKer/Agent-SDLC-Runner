import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { GateRunResult } from '@sdlc-runner/shared';
import type { WitokPaths } from '../artifacts/paths.ts';
import { readCanonicalState, writeCanonicalState } from './canonicalState.ts';
import { assertPlainPath, atomicJson, evidenceFile, fileHash, protectedRunDir, sha256 } from './protectedStore.ts';
import { isolatedNode, pinNodeImage } from './isolatedNode.ts';
import { escapeCell, parseTables } from '../md/table.ts';
import { DECISION, readArtifact, readDecision } from '../artifacts/artifact.ts';
import { manualClaimIds } from '../verdict/collect.ts';
import { readGuided } from './guidedState.ts';

export const ACCEPTANCE_GATE = 'Независимая приёмка';
export const acceptanceRegistrationSchema = z.object({
  sourceDir: z.string().min(1),
  image: z.string().min(1),
  author: z.object({ kind: z.enum(['human', 'model']), id: z.string().min(1) }).strict(),
  qualification: z.string().min(1),
  checks: z.array(z.object({ claimId: z.string().regex(/^claim-[1-9][0-9]*$/), file: z.string().min(1), name: z.string().min(1).regex(/^[^\r\n]+$/) }).strict()).min(1),
  limitations: z.string(),
}).strict();
export type AcceptanceRegistration = z.infer<typeof acceptanceRegistrationSchema>;
interface FrozenSuite {
  version: 1; revision: string; image: string; author: AcceptanceRegistration['author']; qualification: string; limitations: string;
  by: string; at: string; contractHash: string; planHash: string; baseFingerprint: string;
  files: { path: string; sha256: string }[]; checks: AcceptanceRegistration['checks'];
}
interface AcceptanceResult { version: 1; suiteHash: string; contractHash: string; codeHash: string; image: string; executed: boolean; passed: boolean; at: string; logHash: string; }
const registrationPath = (p: WitokPaths) => join(protectedRunDir(p.projectRoot, p.slug), 'acceptance.json');
const manifestPath = (p: WitokPaths) => join(p.dir, 'acceptance-checks.md');
export function acceptanceClaims(paths: WitokPaths) {
  const canonical = readCanonicalState(paths);
  if (canonical) return canonical.state.claims;
  if (!readGuided(paths)) throw new Error('Нужен state-first или guided');
  const intent = readArtifact(paths.intent).text, manual = new Set(manualClaimIds(intent));
  const claims: { id: string; text: string; verification: string; tags?: string[] }[] = [];
  for (const table of parseTables(intent)) for (const row of table.rows) {
    const id = /^claim-[1-9][0-9]*$/.exec((row[0] ?? '').replace(/`/g, '').trim())?.[0];
    if (!id || row.length < 3) continue;
    if (claims.some(c => c.id === id)) throw new Error(`Дублируется требование ${id}`);
    claims.push({ id, text: row[1]!.trim(), verification: row[2]!.trim(), ...(manual.has(id) ? { tags: ['manual'] } : {}) });
  }
  if (!claims.length) throw new Error('Нет явного приёмочного контракта');
  return claims;
}
const contractHash = (p: WitokPaths) => sha256(JSON.stringify(acceptanceClaims(p)));
export const hasIndependentAcceptance = (p: WitokPaths): boolean => existsSync(registrationPath(p));

function within(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

/** Copy regular files only. No symlinks, devices, sockets or unbounded input trees. */
function walk(root: string, visitor: (path: string, bytes: Buffer) => void): void {
  let count = 0, size = 0;
  const visit = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name), stat = lstatSync(path);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error(`Неподдерживаемый файл набора: ${path}`);
      if (stat.isDirectory()) visit(path);
      else {
        if (++count > 10000 || (size += stat.size) > 100 * 1024 * 1024) throw new Error('Превышен бюджет снимка');
        visitor(relative(root, path).replace(/\\/g, '/'), readFileSync(path));
      }
    }
  };
  visit(root);
}

export function candidateFiles(root: string): { path: string; bytes: Buffer }[] {
  const names = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }).split('\0').filter(Boolean);
  if (names.length > 10000) throw new Error('Кандидат превышает бюджет 10000 файлов');
  let size = 0;
  const result: { path: string; bytes: Buffer }[] = [];
  for (const path of [...new Set(names)].sort().filter(path => !/^(?:\.git|\.sdlc|node_modules)(?:\/|$)/i.test(path))) {
    const file = resolve(root, path);
    const stat = lstatSync(file, { throwIfNoEntry: false });
    if (!stat) continue; // A tracked deletion is part of the candidate, not an environment failure.
    if (stat.isSymbolicLink()) throw new Error(`Симлинк в кандидате: ${path}`);
    assertPlainPath(file);
    if (!within(root, file) || !stat.isFile()) throw new Error(`Неподдерживаемый путь кандидата: ${path}`);
    const bytes = readFileSync(file);
    if ((size += bytes.length) > 100 * 1024 * 1024) throw new Error('Кандидат превышает бюджет 100 MiB');
    result.push({ path, bytes });
  }
  return result;
}
const fingerprint = (files: { path: string; bytes: Buffer }[]) => sha256(Buffer.concat(files.flatMap(f => [Buffer.from(f.path + '\0'), f.bytes, Buffer.from('\0')])));

function frozenSuite(paths: WitokPaths): { suite: FrozenSuite; hash: string; root: string } {
  assertPlainPath(registrationPath(paths));
  const raw = readFileSync(registrationPath(paths), 'utf8');
  const suite = JSON.parse(raw) as FrozenSuite;
  if (suite.version !== 1 || !/^[a-f0-9-]{36}$/.test(suite.revision)) throw new Error('Повреждена регистрация независимой приёмки');
  const root = join(protectedRunDir(paths.projectRoot, paths.slug), 'suites', suite.revision);
  assertPlainPath(root);
  if (suite.contractHash !== contractHash(paths) || suite.planHash !== fileHash(paths.plan)) throw new Error('Требования или план изменились после фиксации приёмки');
  const actual: { path: string; sha256: string }[] = [];
  walk(root, (path, bytes) => actual.push({ path, sha256: sha256(bytes) }));
  if (JSON.stringify(actual) !== JSON.stringify(suite.files)) throw new Error('Защищённый набор приёмки изменён');
  return { suite, hash: sha256(raw), root };
}

export function acceptanceProblem(paths: WitokPaths): string | null {
  if (!readCanonicalState(paths) && !readGuided(paths)) return null;
  try {
    const frozen = frozenSuite(paths);
    const baseline = JSON.parse(readFileSync(join(protectedRunDir(paths.projectRoot, paths.slug), 'acceptance-baseline.json'), 'utf8')) as AcceptanceResult;
    if (!baseline.executed || baseline.suiteHash !== frozen.hash) throw new Error('Исходный прогон приёмки не выполнен');
    return null;
  } catch (error) { return `Независимая приёмка не зафиксирована: ${String(error)}`; }
}

/** Operator channel only: never exposed as a model tool. Source and provenance are supplied by the reviewer. */
export async function registerAcceptance(paths: WitokPaths, input: unknown, operator: string, executor: string): Promise<{ revision: string; baselinePassed: boolean }> {
  const registration = acceptanceRegistrationSchema.parse(input);
  const canonical = readCanonicalState(paths);
  if (!canonical && !readGuided(paths)) throw new Error('Сначала включи state-first или guided');
  const approved = canonical ? canonical.state.decisions.filter(d => d.kind === 'plan:approval').at(-1)?.value === 'granted'
    : readDecision(readArtifact(paths.plan).text, DECISION.approval).state === 'granted';
  if (!approved) throw new Error('Сначала требуется одобрение плана');
  if (registration.author.kind === 'model' && registration.author.id === executor) throw new Error('Автор реализации не готовит независимую приёмку');
  const source = realpathSync(registration.sourceDir);
  assertPlainPath(source);
  if (within(paths.projectRoot, source)) throw new Error('Независимый набор должен быть подготовлен вне проекта кандидата');
  const ids = new Set(acceptanceClaims(paths).filter(c => !c.tags?.includes('manual')).map(c => c.id));
  if (!ids.size || registration.checks.some(c => !ids.has(c.claimId)) || [...ids].some(id => !registration.checks.some(c => c.claimId === id))) throw new Error('Приёмка должна покрывать каждый автоматический claim');
  for (const check of registration.checks) {
    if (!/\.(?:test|spec)\.(?:mjs|cjs)$/.test(check.file) || isAbsolute(check.file) || !within(source, resolve(source, check.file))) throw new Error('Поддерживаются явные Node test/spec .mjs/.cjs внутри набора');
    evidenceFile(source, check.file);
  }
  const revision = randomUUID();
  const root = join(protectedRunDir(paths.projectRoot, paths.slug), 'suites', revision);
  assertPlainPath(root); mkdirSync(root, { recursive: true });
  const files: FrozenSuite['files'] = [];
  walk(source, (path, bytes) => {
    const target = join(root, path); mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes, { flag: 'wx', mode: 0o444 }); files.push({ path, sha256: sha256(bytes) });
  });
  const suite: FrozenSuite = { version: 1, revision, image: pinNodeImage(registration.image), author: registration.author, qualification: registration.qualification,
    limitations: registration.limitations, by: operator, at: new Date().toISOString(), contractHash: contractHash(paths), planHash: fileHash(paths.plan),
    baseFingerprint: fingerprint(candidateFiles(paths.projectRoot)), files, checks: registration.checks };
  // A new suite always invalidates prior acceptance and the canonical verdict.
  if (canonical) {
    canonical.state.verification.passed = false; canonical.state.verification.action = 'retry';
    canonical.state.decisions.push({ kind: 'acceptance:freeze', by: operator, at: suite.at, value: revision });
    writeCanonicalState(paths, canonical.state);
  }
  atomicJson(registrationPath(paths), suite);
  const markdown = ['# Независимые приёмочные проверки', '', `- Ревизия: ${revision}`, `- Проверяющий: ${suite.author.kind}:${suite.author.id}`, `- Зафиксировал: ${operator} · ${suite.at}`,
    `- Контракт (SHA-256): ${suite.contractHash}`, `- План (SHA-256): ${suite.planHash}`, `- Образ: ${suite.image}`, `- Ограничения: ${suite.limitations || 'нет'}`, '',
    '| Claim | Тест | Имя проверки |', '|---|---|---|', ...suite.checks.map(c => `| ${c.claimId} | ${c.file} | ${c.name} |`), '', 'Набор хранится вне проекта. Результаты сохраняются отдельно.', ''].join('\n');
  assertPlainPath(manifestPath(paths)); writeFileSync(manifestPath(paths), markdown, 'utf8');
  const baseline = await runIndependentAcceptance(paths, 0, 0);
  const problem = acceptanceProblem(paths);
  if (problem) throw new Error(problem);
  return { revision, baselinePassed: baseline.status === '✅' };
}

export async function runIndependentAcceptance(paths: WitokPaths, chunk: number, attempt: number, signal?: AbortSignal): Promise<GateRunResult> {
  const started = Date.now();
  const result = (passed: boolean, output: string): GateRunResult => ({ name: ACCEPTANCE_GATE, status: passed ? '✅' : '❌', command: 'registered Node acceptance (read-only)', exitCode: passed ? 0 : 1, durationMs: Date.now() - started, lastLine: output, envBlocked: false });
  try {
    const frozen = frozenSuite(paths);
    const files = candidateFiles(paths.projectRoot), codeHash = fingerprint(files);
    const tests = [...new Set(frozen.suite.checks.map(c => `/checks/${c.file.replace(/\\/g, '/')}`))];
    const run = await isolatedNode({ image: frozen.suite.image, files, argv: ['--test', '--test-reporter=/runtime/reporter.mjs', ...tests], suiteRoot: frozen.root, trustedReporter: true, timeoutMs: 60_000, ...(signal ? { signal } : {}) });
    const output = run.stdout + '\n' + run.stderr;
    const events = run.stdout.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as { type: string; name?: string; file?: string; message?: string });
    const summary = events.filter(e => e.type === 'test:diagnostic').map(e => e.message ?? '');
    const count = summary.map(line => /^tests (\d+)$/.exec(line)?.[1]).find(Boolean);
    const checksPresent = frozen.suite.checks.every(c => events.some(e => e.type === 'test:pass' && e.name === c.name && e.file === `/checks/${c.file.replace(/\\/g, '/')}`));
    const checksObserved = frozen.suite.checks.every(c => events.some(e => ['test:pass', 'test:fail'].includes(e.type) && e.name === c.name && e.file === `/checks/${c.file.replace(/\\/g, '/')}`));
    const passed = run.code === 0 && Number(count) > 0 && checksPresent && ['fail 0', 'skipped 0', 'cancelled 0'].every(s => summary.includes(s));
    if (frozenSuite(paths).hash !== frozen.hash || fingerprint(candidateFiles(paths.projectRoot)) !== codeHash) throw new Error('Набор или кандидат изменился во время приёмки');
    const prefix = chunk === 0 ? 'acceptance-baseline' : `acceptance-${chunk}-${attempt}`;
    const directory = join(paths.dir, 'state-evidence');
    const log = join(directory, `${prefix}.txt`);
    assertPlainPath(directory); mkdirSync(directory, { recursive: true }); assertPlainPath(log); writeFileSync(log, output, 'utf8');
    const receipt: AcceptanceResult = { version: 1, suiteHash: frozen.hash, contractHash: frozen.suite.contractHash, codeHash, image: frozen.suite.image, executed: Number(count) > 0 && checksObserved && !run.timedOut && run.code !== null && run.code !== 125, passed, at: new Date().toISOString(), logHash: fileHash(log) };
    atomicJson(join(protectedRunDir(paths.projectRoot, paths.slug), `${prefix}.json`), receipt);
    atomicJson(join(directory, `${prefix}.json`), receipt);
    return result(passed, `${passed ? 'PASS' : 'FAIL'}; suite=${frozen.suite.revision}; tests=${count ?? 'unknown'}; code=${codeHash}; log=${prefix}.txt`);
  } catch (error) { return result(false, `Независимая приёмка не подтверждена: ${String(error)}`); }
}

export function acceptanceImage(paths: WitokPaths): string { return frozenSuite(paths).suite.image; }

/** Project verified executor receipts into the current form; never invent applicability or an exemption. */
export function independentAcceptanceReport(paths: WitokPaths, chunk: number, attempt: number): string | null {
  if (!readCanonicalState(paths) && !hasIndependentAcceptance(paths)) return null;
  try {
    const frozen = frozenSuite(paths);
    const prefix = `acceptance-${chunk}-${attempt}`;
    const receipt = JSON.parse(readFileSync(join(protectedRunDir(paths.projectRoot, paths.slug), `${prefix}.json`), 'utf8')) as AcceptanceResult;
    const log = join(paths.dir, 'state-evidence', `${prefix}.txt`);
    if (receipt.image !== frozen.suite.image || receipt.suiteHash !== frozen.hash || receipt.contractHash !== contractHash(paths) ||
      receipt.codeHash !== fingerprint(candidateFiles(paths.projectRoot)) || receipt.logHash !== fileHash(log)) return null;
    const baseline = JSON.parse(readFileSync(join(protectedRunDir(paths.projectRoot, paths.slug), 'acceptance-baseline.json'), 'utf8')) as AcceptanceResult;
    if (!baseline.executed || baseline.suiteHash !== frozen.hash) return null;
    return ['## Независимые приёмочные проверки', '',
      '- **Применимость:** обязательна: оператор зарегистрировал независимый набор для одобренного контракта и плана.',
      `- **Зафиксированный набор:** acceptance-checks.md; SHA-256 ${frozen.hash}; проверяющий ${escapeCell(frozen.suite.author.kind + ':' + frozen.suite.author.id)}; зафиксировал ${escapeCell(frozen.suite.by)}.`,
      `- **Прогон кандидата:** ${receipt.executed ? 'выполнен' : 'не подтверждён'}; ${receipt.passed ? 'PASS' : 'FAIL'}; код ${receipt.codeHash}; образ ${escapeCell(receipt.image)}; лог state-evidence/${prefix}.txt; SHA-256 ${receipt.logHash}.`,
      `- **Защита и чувствительность:** отдельный исполнитель Docker без сети, кандидат и тесты только для чтения; исходный прогон ${baseline.passed ? 'PASS' : 'FAIL'}. Ограничения проверяющего: ${escapeCell(frozen.suite.limitations || 'не заявлены')}.`, '',
    ].join('\n');
  } catch { return null; }
}

export function acceptanceFresh(paths: WitokPaths, chunk: number, attempt: number): boolean {
  try {
    const frozen = frozenSuite(paths), prefix = `acceptance-${chunk}-${attempt}`;
    const receipt = JSON.parse(readFileSync(join(protectedRunDir(paths.projectRoot, paths.slug), `${prefix}.json`), 'utf8')) as AcceptanceResult;
    return receipt.passed && receipt.suiteHash === frozen.hash && receipt.contractHash === contractHash(paths) && receipt.codeHash === fingerprint(candidateFiles(paths.projectRoot)) && receipt.logHash === fileHash(join(paths.dir, 'state-evidence', `${prefix}.txt`));
  } catch { return false; }
}
