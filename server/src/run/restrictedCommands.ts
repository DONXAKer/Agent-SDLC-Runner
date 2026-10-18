import { AsyncLocalStorage } from 'node:async_hooks';
import type { WitokPaths } from '../artifacts/paths.ts';
import type { ShellOptions, ShellResult } from '../gates/shell.ts';
import { candidateFiles, acceptanceImage } from './independentAcceptance.ts';
import { isolatedNode } from './isolatedNode.ts';

const context = new AsyncLocalStorage<WitokPaths | null>();
export const withRestrictedCommands = <T>(paths: WitokPaths, action: () => T): T => context.run(paths, action);
export const withRuntimeCommands = <T>(action: () => T): T => context.run(null, action);
export const commandsRestricted = (): boolean => context.getStore() != null;

export function restrictedCommand(command: string, opts: ShellOptions): Promise<ShellResult> | null {
  const paths = context.getStore();
  if (!paths) return null;
  const started = Date.now();
  return (async () => {
    try {
      // Deliberately no shell expansion, command chaining, npm scripts or interpreter snippets.
      const tokens: string[] = [];
      const token = /\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s'"`$;&|<>]+))/gy;
      let at = 0;
      while (at < command.trimEnd().length) {
        token.lastIndex = at; const match = token.exec(command);
        if (!match) throw new Error('Поддерживается только простая команда Node без оболочки');
        tokens.push(match[1] ?? match[2] ?? match[3]!); at = token.lastIndex;
      }
      if (tokens.shift() !== 'node' || !tokens.length || tokens.some(t => /^(?:-[ep]|--(?:eval|print)(?:=|$))/.test(t))) throw new Error('State-first: требуется зарегистрированная Node-команда без eval');
      if (opts.cwd.replace(/\\/g, '/').replace(/\/$/, '') !== paths.projectRoot.replace(/\\/g, '/').replace(/\/$/, '')) throw new Error('State-first: команды из подкаталогов пока не поддерживаются');
      const run = await isolatedNode({ image: acceptanceImage(paths), files: candidateFiles(paths.projectRoot), argv: tokens, timeoutMs: opts.timeoutMs, ...(opts.signal ? { signal: opts.signal } : {}) });
      return { exitCode: run.code, stdout: run.stdout, stderr: run.stderr, lastLine: (run.stdout + '\n' + run.stderr).trim().split(/\r?\n/).at(-1) ?? '', durationMs: Date.now() - started, timedOut: run.timedOut, denied: null };
    } catch (error) {
      return { exitCode: null, stdout: '', stderr: String(error), lastLine: String(error), durationMs: Date.now() - started, timedOut: false, denied: String(error) };
    }
  })();
}
