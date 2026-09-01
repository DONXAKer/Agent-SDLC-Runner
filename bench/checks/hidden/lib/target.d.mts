export function targetDir(family: string): string;
export function readExpected(slug: string): { cases: Array<Record<string, unknown> & { id: string; category: string }> } & Record<string, unknown>;
export function importIndex(target: string): Promise<Record<string, unknown>>;
export function caseLabel(c: { id: string; category: string; claim?: string | null; description: string }): string;
export function exportOf(mod: Record<string, unknown>, name: string): (...args: unknown[]) => unknown;
