import { resolve } from 'node:path';
import { runTaskLoopPilot, pilotCases } from '../bench/src/taskLoopPilot.ts';
const argv = process.argv.slice(2);
const option = (flag: string, fallback: string): string => { const i = argv.indexOf(flag); if (i >= 0 && !argv[i + 1]) throw new Error(`Missing ${flag}`); return i < 0 ? fallback : argv[i + 1]!; };
const root = resolve('.');
if (!argv.includes('--run')) {
  console.log(JSON.stringify({ usage: 'node tools/task-loop-pilot.ts --run --task <id> --model <route|assistant-session> --output <dir> [--bridge <dir>] [--max-cost <provider currency>]', tasks: pilotCases(root).map(c => c.task), timeoutMs: 600000, maxTurns: 40 }, null, 2));
} else {
  await runTaskLoopPilot({ root, task: option('--task', 'add-validator'), model: option('--model', 'ollama:qwen3.8-27b-iq4-gpumax'),
    output: option('--output', `bench/results/task-loop-${Date.now()}`), timeoutMs: Number(option('--timeout-ms', '600000')), maxTurns: Number(option('--max-turns', '40')),
    maxCost: argv.includes('--max-cost') ? Number(option('--max-cost', '')) : null,
    structuredFeedback: argv.includes('--structured-feedback'),
    ...(argv.includes('--bridge') ? { bridge: option('--bridge', '') } : {}),
    ...(argv.includes('--cases-file') ? { casesFile: option('--cases-file', '') } : {}) });
}
