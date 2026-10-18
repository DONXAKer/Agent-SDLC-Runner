import { deepStrictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ToolName } from '@sdlc-runner/shared';
import { preparationTools } from '../src/run/preparationToolPolicy.ts';

const tools = ['Read', 'Grep', 'Write', 'Edit', 'AskHuman', 'FinalizeArtifact', 'FillField'] as ToolName[];

describe('preparation v2 tool policy', () => {
  it('allows the structured executors to write assembled artifacts through the gate', () => {
    for (const stage of ['intent', 'explore', 'plan'] as const) {
      deepStrictEqual(preparationTools(tools, stage, true, true), ['Write', 'Edit']);
      deepStrictEqual(preparationTools(tools, stage, true, false), ['Write', 'Edit']);
    }
  });

  it('allows only source reading, human questions, and completion on ask', () => {
    deepStrictEqual(preparationTools(tools, 'ask', true, true), ['Read', 'AskHuman', 'FinalizeArtifact']);
  });

  it('preserves non-v2 compact fill behavior', () => {
    deepStrictEqual(preparationTools(tools, 'plan', false, true), tools);
    deepStrictEqual(preparationTools(tools, 'intent', false, false), tools.filter((tool) => tool !== 'FillField'));
  });
});
