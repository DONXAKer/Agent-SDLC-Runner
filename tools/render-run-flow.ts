import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { parseEventsFile } from '../server/src/eventLog.ts';
import { flowFromEvents, readFlowTrace, renderRunFlow } from '../server/src/run/runFlow.ts';

const { values } = parseArgs({ options: { events: { type: 'string' }, trace: { type: 'string' }, out: { type: 'string' }, slug: { type: 'string' } } });
if ((!values.events && !values.trace) || (values.events && values.trace) || !values.out) {
  throw new Error('Использование: node tools/render-run-flow.ts --events events.ndjson --out flow.html [--slug имя]; либо --trace trace.ndjson');
}
const input = resolve(values.trace ?? values.events!);
const slug = values.slug ?? basename(dirname(input));
const report = values.trace ? readFlowTrace(input, slug) : flowFromEvents(parseEventsFile(input), slug);
const output = resolve(values.out);
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, renderRunFlow(report), 'utf8');
console.log(output);
