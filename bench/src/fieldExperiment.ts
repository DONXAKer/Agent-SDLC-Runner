/** Paired, local-only replay of an observed scalar failure. No tool execution. */
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { loadConfig } from '../../server/src/config/load.ts';
import { createProvider } from '../../server/src/provider/registry.ts';
import type { ChatMessage } from '../../server/src/provider/ChatProvider.ts';
import { deriveSchema } from '../../server/src/artifacts/formSchema.ts';
import { compactScalarContext, cleanFieldAnswer } from '../../server/src/exec/FormFillExecutor.ts';
import { digest } from './diagnostics.ts';

const args = process.argv.slice(2);
function required(flag: string): string {
  const i = args.indexOf(flag);
  if (i < 0 || !args[i + 1]) throw new Error(`required: ${flag}`);
  return args[i + 1]!;
}
const modelId = required('--model');
const source = required('--raw');
const artifact = required('--artifact');
const fieldId = required('--field');
const expected = required('--expected');
const out = resolve(required('--out'));
if (existsSync(out)) throw new Error(`refusing to overwrite experiment: ${out}`);
const config = loadConfig();
const model = config.models.models.find((m) => m.id === modelId);
if (!model || !['ollama', 'lmstudio'].includes(model.provider)) throw new Error('field experiments require a local model');
const provider = createProvider(model.provider, config.models.providers[model.provider]!, 180_000);
const raw = JSON.parse(readFileSync(source, 'utf8')) as { request: { messages: ChatMessage[]; max_tokens?: number } };
const template = readFileSync(artifact, 'utf8');
const field = deriveSchema(template).fields.find((f) => f.id === fieldId);
if (!field || field.kind !== 'scalar') throw new Error(`scalar not found: ${fieldId}`);
const context = compactScalarContext(field, template).join('\n');
const anchor = `- id: \`${fieldId}\``;
const last = raw.request.messages.at(-1);
if (!last || typeof last.content !== 'string' || !last.content.includes(anchor)) throw new Error('raw request does not ask this field');
const records: unknown[] = [];
mkdirSync(dirname(out), { recursive: true });
for (let repeat = 1; repeat <= 3; repeat++) {
  // Alternate order to reduce warmup/order bias; preserve all other request settings.
  for (const variant of repeat % 2 ? ['baseline', 'scalar-context'] : ['scalar-context', 'baseline']) {
    const messages = structuredClone(raw.request.messages);
    if (variant === 'scalar-context') {
      const message = messages.at(-1)!;
      message.content = String(message.content).replace(anchor, `${anchor}\n${context}`);
    }
    const startedAt = new Date().toISOString();
    console.log(`${modelId} ${variant} repeat=${repeat} started=${startedAt}`);
    const requestHash = digest(JSON.stringify(messages));
    let infrastructureError = false;
    try {
      const answer = await provider.chat({
        model: model.model, messages, tools: [], temperature: null,
        params: { ...model.params, ...(raw.request.max_tokens === undefined ? {} : { max_tokens: raw.request.max_tokens }) },
        signal: AbortSignal.timeout(180_000),
      });
      const value = cleanFieldAnswer(answer.text);
      records.push({ variant, repeat, startedAt, requestHash, answer: answer.text, value,
        accepted: value === expected, usage: answer.usage, finishReason: answer.finishReason });
      console.log(`${variant}: accepted=${value === expected} answer=${JSON.stringify(value).slice(0, 180)}`);
    } catch (error) {
      infrastructureError = true;
      records.push({ variant, repeat, startedAt, requestHash, error: String(error), accepted: null });
      console.log(`${variant}: incomplete ${String(error)}`);
    }
    writeFileSync(out, JSON.stringify({ version: 1, modelId, sourceHash: digest(readFileSync(source)), fieldId,
      expected, context, records }, null, 2) + '\n');
    // One failed transport is enough to stop this paired experiment: do not compare unmatched samples.
    if (infrastructureError) process.exit(2);
  }
}
