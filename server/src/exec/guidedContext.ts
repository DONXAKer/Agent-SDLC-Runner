import { estimateMessageTokens } from './contextBudget.ts';
import { guidedQuestion } from './guidedProtocol.ts';

/** Deduplicate the current document from the stage packet. Its up-to-date fields
 * are supplied separately, so a model cannot confuse an old snapshot with new facts.
 * Original requests, other artifacts and operator instructions stay verbatim. */
export function guidedFieldInput(input: unknown, currentPaths: readonly string[]): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const envelope = input as Record<string, unknown>;
  const data = envelope.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return input;
  const values = data as Record<string, unknown>;
  if (!Array.isArray(values.artifacts)) return input;
  const normalize = (path: string) => path.replace(/\\/gu, '/');
  const paths = new Set(currentPaths.map(normalize));
  return { ...envelope, data: { ...values, artifacts: values.artifacts.filter(artifact =>
    !artifact || typeof artifact !== 'object' || typeof artifact.path !== 'string' || !paths.has(normalize(artifact.path))) } };
}

function shrinkString(value: string): string {
  return value.length <= 128 ? value : value.slice(0, Math.floor(value.length / 2));
}

function shrinkUnknown(value: unknown): { value: unknown; changed: boolean } {
  if (typeof value === 'string') {
    const next = shrinkString(value);
    return { value: next, changed: next !== value };
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return { value, changed: false };
    if (value.every((item) => typeof item !== 'string' || item.length <= 128)) {
      return { value: value.slice(0, -1), changed: true };
    }
    let changed = false;
    const next = value.map((item) => {
      const shrunk = shrinkUnknown(item);
      changed = changed || shrunk.changed;
      return shrunk.value;
    });
    return { value: next, changed };
  }
  if (value && typeof value === 'object') {
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const shrunk = shrinkUnknown(item);
      next[key] = shrunk.value;
      changed = changed || shrunk.changed;
    }
    return { value: next, changed };
  }
  return { value, changed: false };
}

function artifactsOf(data: Record<string, unknown>): unknown[] | null {
  const input = data['input'];
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const envelope = input as Record<string, unknown>;
    const inner = envelope['data'];
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
      const arts = (inner as Record<string, unknown>)['artifacts'];
      if (Array.isArray(arts)) return arts;
    }
    if (Array.isArray(envelope['artifacts'])) return envelope['artifacts'] as unknown[];
  }
  return Array.isArray(data['artifacts']) ? data['artifacts'] as unknown[] : null;
}

function markTruncated(data: Record<string, unknown>): void {
  data['truncatedForContext'] = true;
  const input = data['input'];
  if (!input || typeof input !== 'object' || Array.isArray(input)) return;
  const envelope = input as Record<string, unknown>;
  const inner = envelope['data'];
  if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
    (inner as Record<string, unknown>)['truncatedForContext'] = true;
  }
}

function artifactPriority(item: unknown): number {
  if (!item || typeof item !== 'object') return 0;
  const path = String((item as { path?: unknown }).path ?? '').replace(/\\/gu, '/').toLowerCase();
  if (path.includes('journal')) return 0;
  if (path.includes('verification-report') || path.endsWith('gates.md')) return 1;
  if (path.includes('exploration') || path.includes('readiness') || path.includes('clarification')) return 2;
  if (path.endsWith('plan.md')) return 3;
  if (path.endsWith('intent.md')) return 4;
  return 2;
}

function protectedArtifact(item: unknown): boolean {
  if (!item || typeof item !== 'object') return false;
  return /(?:^|\/)(?:intent|plan|clarification-report)\.md$/u.test(String((item as { path?: unknown }).path ?? '').replace(/\\/gu, '/'));
}

function dropArtifact(arts: unknown[], protectContract: boolean): boolean {
  if (arts.length <= 1) return false;
  let worst = arts.findIndex(item => !protectContract || !protectedArtifact(item));
  if (worst < 0) return false;
  for (let i = worst + 1; i < arts.length; i++) {
    if (protectContract && protectedArtifact(arts[i])) continue;
    if (artifactPriority(arts[i]) < artifactPriority(arts[worst])) worst = i;
  }
  arts.splice(worst, 1);
  return true;
}

/** Один шаг ужатия полевого пакета: секции артефактов → выкинуть низкоприоритетный → факты поля. */
export function shrinkGuidedFieldData(data: Record<string, unknown>, protectContract = false): boolean {
  const arts = artifactsOf(data);
  if (arts && arts.length > 0) {
    let changed = false;
    for (const art of arts) {
      if (protectContract && protectedArtifact(art)) continue;
      if (!art || typeof art !== 'object') continue;
      const record = art as Record<string, unknown>;
      if (Array.isArray(record['sections'])) {
        const shrunk = shrinkUnknown(record['sections']);
        if (shrunk.changed) {
          record['sections'] = shrunk.value;
          record['partial'] = true;
          changed = true;
        }
      }
      if (typeof record['content'] === 'string' && record['content'].length > 128) {
        record['content'] = shrinkString(record['content']);
        record['partial'] = true;
        changed = true;
      }
    }
    if (changed) {
      markTruncated(data);
      return true;
    }
    if (dropArtifact(arts, protectContract)) {
      markTruncated(data);
      return true;
    }
  }
  // Required predicates, cited facts, current values and repair feedback remain exact.
  // A smaller optional file catalogue is safe; shortening paths or source quotes is not.
  if (protectContract) {
    if (Array.isArray(data.projectFiles) && data.projectFiles.length) {
      data.projectFiles = data.projectFiles.slice(0, -1); markTruncated(data); return true;
    }
    return false;
  }
  for (const key of ['currentFacts', 'sourceFacts', 'projectFiles'] as const) {
    if (data[key] === undefined) continue;
    const shrunk = shrinkUnknown(data[key]);
    if (shrunk.changed) {
      data[key] = shrunk.value;
      markTruncated(data);
      return true;
    }
  }
  for (const key of ['answerRequirements'] as const) {
    if (typeof data[key] === 'string' && data[key].length > 64) {
      data[key] = shrinkString(data[key]);
      markTruncated(data);
      return true;
    }
  }
  return false;
}

/**
 * Ужимает данные полевого guided-запроса, пока system+вопрос и запас ответа
 * помещаются в окно — тот же приём, что `packGuidedPreparationReview`.
 * Без этого handoff на 16k слал 26k+ токенов и жег бюджет пустыми JSON.
 */
export function packGuidedFieldQuestion(
  system: string,
  questionId: string,
  questionText: string,
  data: Record<string, unknown>,
  contextWindow: number | undefined,
  options: { protectContract?: boolean } = {},
): { question: string; available: number; truncated: boolean; data: Record<string, unknown> } {
  const window = contextWindow !== undefined && contextWindow > 0 ? contextWindow : 16384;
  let packed = structuredClone(data) as Record<string, unknown>;
  let truncated = false;
  for (;;) {
    const question = guidedQuestion(questionId, questionText, packed);
    const available = window - estimateMessageTokens([{ content: system }, { content: question }]) - 1024;
    if (available >= 512) return { question, available, truncated, data: packed };
    if (!shrinkGuidedFieldData(packed, options.protectContract === true)) {
      throw new Error(options.protectContract ? 'Обязательный контракт не помещается в контекст; требуется сузить задачу. Условия не сокращены.' : 'Полевой guided-запрос не помещается в контекст');
    }
    truncated = true;
  }
}

/** A group's acceptance clauses are the immediate goal. Global constraints and
 * the original request remain available to prevent local edits violating scope. */
export function guidedGroupRequirements(raw: string | undefined, claimIds: readonly string[]): unknown {
  if (!raw) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return raw; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  const ids = new Set(claimIds);
  const filter = (rows: unknown) => Array.isArray(rows) ? rows.filter(row => row && typeof row === 'object' && ids.has(row.id)) : rows;
  return { ...record, acceptance: filter(record.acceptance), basis: filter(record.basis),
    otherRequirementIds: Array.isArray(record.acceptance) ? record.acceptance.map(row => row.id).filter(id => !ids.has(id)) : [] };
}
