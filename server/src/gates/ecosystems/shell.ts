import type { Ecosystem } from './types.ts';

export const shell: Ecosystem = {
  id: 'shell',
  label: 'Shell',
  // Привычного манифеста у shell-проектов нет; `.shellcheckrc` — единственный файл,
  // который точно говорит «здесь живут скрипты и их проверяют». Модуль без него не
  // детектится, но пофайловый синтаксис-чек и линт всё равно находятся по расширению —
  // `syntaxCheckerFor` и фильтр `codeExt` манифестам не следуют.
  manifests: ['.shellcheckrc'],
  commands: () => ({ build: null, test: null, depsDir: null }),
  codeExt: ['.sh', '.bash'],
  // `bash -n` читает файл без исполнения — уровень `node --check`.
  syntaxCheck: (file) => ({ cmd: 'bash', args: ['-n', file] }),
  // shellcheck ставится отдельно: нет на машине → честный ⏭ от гейта.
  lint: (files) => ({ cmd: 'shellcheck', args: [...files], scope: 'files' }),
  disableMarkers: [],
  testDecl: [],
};
