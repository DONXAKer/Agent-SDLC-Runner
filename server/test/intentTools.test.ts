import { strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { intentStage } from '../src/run/stages/intent.ts';

describe('intent stage tool boundary', () => {
  it('records questions for explore/ask instead of calling the human before source review', () => {
    strictEqual(intentStage.tools.includes('AskHuman'), false);
  });
});
