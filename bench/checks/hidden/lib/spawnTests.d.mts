export interface TargetTestRun {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  tests: number;
  pass: number;
  fail: number;
  skipped: number;
  todo: number;
  cancelled: number;
}
export interface TargetTestsOptions {
  pattern?: string;
  timeoutMs?: number;
}
export function runTargetTestsOnce(target: string, opts?: TargetTestsOptions): Promise<TargetTestRun>;
export function runTargetTests(
  target: string,
  opts?: TargetTestsOptions & { times?: number },
): Promise<{ runs: TargetTestRun[]; greenRuns: number; allGreen: boolean }>;
