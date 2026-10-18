import '../acceptance/winter.mjs';
import { test } from 'node:test';
import { assertFunction } from './module-contract.mjs';
test('G3 [contract]: required source module exports the function', () => assertFunction('src/trip.ts', 'winterFuelMl'));
