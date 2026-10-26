import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { normalizeLmStudioCapabilities, normalizeOllamaCapabilities } from '../src/provider/capabilities.ts';

describe('model capabilities', () => {
  it('reads Ollama capabilities without treating an old response as unsupported', () => {
    const full = normalizeOllamaCapabilities('ollama', 'm', { capabilities: ['completion', 'tools', 'thinking'] });
    strictEqual(full.tools, 'supported');
    strictEqual(full.reasoning, 'supported');
    const plain = normalizeOllamaCapabilities('ollama', 'm', { capabilities: ['completion'] });
    strictEqual(plain.tools, 'unsupported');
    strictEqual(plain.reasoning, 'unsupported');
    const old = normalizeOllamaCapabilities('ollama', 'm', { parameters: 'num_ctx 32768' });
    strictEqual(old.tools, 'unknown');
    strictEqual(old.reasoning, 'unknown');
  });

  it('normalizes LM Studio object and legacy array capabilities', () => {
    const object = normalizeLmStudioCapabilities('lmstudio', 'm', {
      capabilities: { trained_for_tool_use: false, reasoning: { allowed_options: ['off', 'on'], default: 'off' } },
    });
    strictEqual(object.tools, 'unsupported');
    strictEqual(object.reasoning, 'supported');
    deepStrictEqual(object.reasoningOptions, ['off', 'on']);
    strictEqual(object.reasoningDefault, 'off');
    const legacy = normalizeLmStudioCapabilities('lmstudio', 'm', { capabilities: ['tools', 'reasoning'] });
    strictEqual(legacy.tools, 'supported');
    strictEqual(legacy.reasoning, 'supported');
    const old = normalizeLmStudioCapabilities('lmstudio', 'm', { state: 'loaded' });
    strictEqual(old.tools, 'unknown');
    strictEqual(old.reasoning, 'unknown');
  });
});
