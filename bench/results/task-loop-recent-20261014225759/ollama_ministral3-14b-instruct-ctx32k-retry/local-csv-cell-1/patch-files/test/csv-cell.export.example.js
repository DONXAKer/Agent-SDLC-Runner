import { csvRow } from '../src/format.mjs';

export function buildRow(values) {
    return csvRow(values);
}