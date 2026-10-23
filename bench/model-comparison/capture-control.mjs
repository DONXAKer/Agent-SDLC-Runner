import { writeFileSync } from 'node:fs';
import { loadConfig } from '../../server/src/config/load.ts';
import { baseUrlFor } from '../../server/src/provider/registry.ts';

const config = loadConfig();
const model = config.models.models.find(m => m.id === 'ollama:qwen3.8-27b-iq4-gpumax');
if (!model) throw new Error('Missing local control profile');
const base = (baseUrlFor(model.provider) ?? config.models.providers[model.provider].baseUrl).replace(/\/v1\/?$/, '');
const response = await fetch(`${base}/api/show`, { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: model.model }), signal: AbortSignal.timeout(30_000) });
if (!response.ok) throw new Error(`Control metadata HTTP ${response.status}`);
const value = await response.json();
writeFileSync('.tmp/model-comparison-20261019/control-tag.json', JSON.stringify({ capturedAt: new Date().toISOString(), model: model.model,
  parameters: value.parameters, details: value.details, capabilities: value.capabilities, modelInfo: value.model_info }, null, 2) + '\n');
console.log(value.parameters);
