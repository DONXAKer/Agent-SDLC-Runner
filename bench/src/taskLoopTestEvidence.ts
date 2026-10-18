import { spawnNode } from './nodeTest.ts';

export interface ExecutedTestCount { tests: number; passed: number; failed: number; skipped: number; cancelled: number; todo: number }
export function parseExecutedTests(output: string): ExecutedTestCount | null {
  const read = (key: string): number | null => {
    const values = [...output.matchAll(new RegExp(`^# ${key} (\\d+)\\r?$`, 'gm'))];
    const value = values.at(-1)?.[1]; return value === undefined ? null : Number(value);
  };
  const tests = read('tests'), passed = read('pass'), failed = read('fail'), skipped = read('skipped'), cancelled = read('cancelled'), todo = read('todo');
  return tests === null || passed === null || failed === null || skipped === null || cancelled === null || todo === null ? null
    : { tests, passed, failed, skipped, cancelled, todo };
}
export async function additionalExecutedTests(args: { baselineDir: string; targetDir: string; commandArgs: readonly string[] }) {
  if (!args.commandArgs.includes('--test')) return { passed: false, baseline: null, final: null, reason: 'Registered check is not a Node test runner' };
  const command = ['--test-reporter=tap', ...args.commandArgs.filter(arg => !arg.startsWith('--test-reporter='))];
  const baselineOutput = await spawnNode({ args: command, cwd: args.baselineDir, timeoutMs: 60000 });
  const finalOutput = await spawnNode({ args: command, cwd: args.targetDir, timeoutMs: 60000 });
  const baseline = parseExecutedTests(baselineOutput.stdout), final = parseExecutedTests(finalOutput.stdout);
  const passed = baselineOutput.exitCode === 0 && finalOutput.exitCode === 0 && !baselineOutput.timedOut && !finalOutput.timedOut &&
    baseline !== null && final !== null && baseline.failed === 0 && final.failed === 0 && final.cancelled === 0 && final.passed > baseline.passed;
  return { passed, baseline, final, reason: passed ? 'Additional tests executed successfully' : 'No evidence of additional passing tests',
    baselineExitCode: baselineOutput.exitCode, finalExitCode: finalOutput.exitCode };
}
