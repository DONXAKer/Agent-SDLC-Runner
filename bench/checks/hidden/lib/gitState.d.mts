import type { TestContext } from 'node:test';

export function gitAvailable(target: string): boolean;
export function porcelain(target: string, paths: readonly string[]): string;
export function diffStat(target: string, paths: readonly string[]): string;
export function skipUnlessGit(t: TestContext, target: string): boolean;
