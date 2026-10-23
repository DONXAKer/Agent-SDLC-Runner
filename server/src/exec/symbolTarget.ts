import { createHash } from 'node:crypto';
import { findSymbols, declarationId } from './symbolOps.ts';

/** Exact, case-sensitive declaration identities, derived from the current source. */
export function describeSymbolTargets(file: string, text: string, symbol: string) {
  const declarations = findSymbols(text);
  const exact = declarations.filter(decl => decl.qualified === symbol);
  const selected = exact.length ? exact : declarations.filter(decl => decl.name === symbol);
  const hash = createHash('sha256').update(text).digest('hex');
  return selected.map(decl => ({ file, hash, targetId: declarationId(text, decl), ...decl }));
}
