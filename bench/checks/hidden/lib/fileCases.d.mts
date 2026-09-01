export type FileMatcher = string | { regex: string; flags?: string };
export interface FileCase {
  file: string;
  mustContain?: readonly FileMatcher[];
  mustNotContain?: readonly FileMatcher[];
}
export function fileCaseProblems(target: string, c: FileCase): string[];
export function assertFileCase(target: string, c: FileCase): void;
