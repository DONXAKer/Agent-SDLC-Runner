import '../acceptance/zone.mjs';
import { test } from 'node:test';
import { assertFunction } from './module-contract.mjs';
test('G4 [contract]: required source module exports the command', () => assertFunction('src/commands.ts', 'run'));
