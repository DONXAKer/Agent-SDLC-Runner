import type { Ecosystem } from './types.ts';

export const python: Ecosystem = {
  id: 'python',
  label: 'Python',
  manifests: ['pyproject.toml', 'setup.py', 'pytest.ini', 'setup.cfg'],
  commands: () => ({
    build: 'python3 -m compileall -q .',
    test: 'python3 -m pytest -q',
    depsDir: null,
  }),
  codeExt: ['.py'],
  // `py_compile` без `-` пишет рядом `.pyc`, а это правка файлов мимо плана: scope-гейт
  // увидел бы её как выход за границы. Флаг `-c` компилирует из stdin, поэтому файл
  // подаётся как исходник, а байткод никуда не сохраняется.
  syntaxCheck: (file) => ({
    cmd: 'python3',
    args: ['-c', 'import ast,sys; ast.parse(open(sys.argv[1],encoding="utf-8").read(), sys.argv[1])', file],
  }),
  lint: (files) => ({ cmd: 'ruff', args: ['check', ...files], scope: 'files' }),
  disableMarkers: ['@pytest.mark.skip', '@unittest.skip', 'pytest.skip('],
  testDecl: ['def test_'],
};
