import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { buildCorpus, writeCorpus } from '../src/corpus.ts';

function json(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value)}\n`, 'utf8');
}

describe('корпус дообучения', () => {
  it('берёт только подтверждённые пары и не пропускает held-out задачу', () => {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-corpus-'));
    const raw = join(root, 'raw');
    const results = join(root, 'results');
    mkdirSync(join(raw, 'train-run'), { recursive: true });
    mkdirSync(join(raw, 'test-run'), { recursive: true });
    mkdirSync(results);
    try {
      json(join(results, 'train.json'), { run: { slug: 'train-run', task: 'freeship' } });
      json(join(results, 'test.json'), { run: { slug: 'test-run', task: 'oversize' } });
      const exchange = (slug: string) => ({
        slug,
        stage: 'chunk',
        mode: 'step',
        provider: 'ollama',
        model: 'qwen',
        status: 200,
        request: { messages: [{ role: 'user', content: 'исправь' }], tools: [] },
        response: JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'готово' } }] }),
      });
      json(join(raw, 'train-run', '00001-chunk-step.json'), exchange('train-run'));
      json(join(raw, 'train-run', '00001-chunk-step.json.label.json'), {
        accepted: true,
        oracle: 'step-check',
        target: 'plan-step',
      });
      json(join(raw, 'train-run', '00002-chunk-step.json'), exchange('train-run'));
      json(join(raw, 'train-run', '00002-chunk-step.json.label.json'), { accepted: false, oracle: 'step-check' });
      json(join(raw, 'test-run', '00003-chunk-step.json'), exchange('test-run'));
      json(join(raw, 'test-run', '00003-chunk-step.json.label.json'), { accepted: true, oracle: 'step-check' });

      const built = buildCorpus({ rawDir: raw, resultsDir: results });
      strictEqual(built.examples.length, 1);
      deepStrictEqual(built.examples[0]?.messages, [
        { role: 'user', content: 'исправь' },
        { role: 'assistant', content: 'готово' },
      ]);
      deepStrictEqual(built.report.rejected, { 'oracle-rejected': 1, 'held-out-task': 1 });
      deepStrictEqual(built.report.tasks, { freeship: 1 });

      const out = join(root, 'out', 'train.jsonl');
      writeCorpus(out, built.examples);
      strictEqual(readFileSync(out, 'utf8').trim().split('\n').length, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('не угадывает качество по результату витка без sidecar-метки', () => {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-corpus-unlabelled-'));
    const raw = join(root, 'raw', 'run');
    const results = join(root, 'results');
    mkdirSync(raw, { recursive: true });
    mkdirSync(results);
    try {
      json(join(results, 'run.json'), { run: { slug: 'run', task: 'freeship' }, finalVerdict: { passed: true } });
      json(join(raw, '00001-plan-formFill.json'), {
        slug: 'run', stage: 'plan', mode: 'formFill', provider: 'ollama', model: 'm', status: 200,
        request: { messages: [] }, response: JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'x' } }] }),
      });
      const built = buildCorpus({ rawDir: join(root, 'raw'), resultsDir: results });
      strictEqual(built.examples.length, 0);
      deepStrictEqual(built.report.rejected, { 'missing-label': 1 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('обмен с плохим HTTP-статусом отклоняется как provider-error, а не missing-label (code-review-all, 2026-09-27)', () => {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-corpus-providererror-'));
    const raw = join(root, 'raw', 'run');
    const results = join(root, 'results');
    mkdirSync(raw, { recursive: true });
    mkdirSync(results);
    try {
      json(join(results, 'run.json'), { run: { slug: 'run', task: 'freeship' } });
      // Статус вне 200-299 и НЕТ .label.json — ровно то, что оставляет `OpenAiCompatProvider`
      // за собой, когда `chat()` бросает исключение после дампа неудачного ответа: разметить
      // такой обмен некому, у вызывающего никогда не было ChatTurn для него.
      json(join(raw, '00001-plan-formFill.json'), {
        slug: 'run',
        stage: 'plan',
        mode: 'formFill',
        provider: 'ollama',
        model: 'm',
        status: 503,
        request: { messages: [] },
        response: '{"error":"upstream unavailable"}',
      });
      const built = buildCorpus({ rawDir: join(root, 'raw'), resultsDir: results });
      strictEqual(built.examples.length, 0);
      deepStrictEqual(built.report.rejected, { 'provider-error': 1 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('коллизия слага между двумя файлами результата — свежий по mtime побеждает, конфликт назван в отчёте', () => {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-corpus-slugconflict-'));
    const raw = join(root, 'raw', 'run');
    const results = join(root, 'results');
    mkdirSync(raw, { recursive: true });
    mkdirSync(results);
    try {
      // Архивный результат того же слага — другая задача, старее по mtime.
      json(join(results, 'old.json'), { run: { slug: 'run', task: 'oversize' } });
      json(join(results, 'new.json'), { run: { slug: 'run', task: 'freeship' } });
      const old = new Date(Date.now() - 60_000);
      utimesSync(join(results, 'old.json'), old, old);
      const exchange = {
        slug: 'run',
        stage: 'chunk',
        mode: 'step',
        provider: 'ollama',
        model: 'm',
        status: 200,
        request: { messages: [{ role: 'user', content: 'исправь' }] },
        response: JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'готово' } }] }),
      };
      json(join(raw, '00001-chunk-step.json'), exchange);
      json(join(raw, '00001-chunk-step.json.label.json'), { accepted: true, oracle: 'step-check' });

      const built = buildCorpus({ rawDir: join(root, 'raw'), resultsDir: results });
      // Свежий (freeship, не held-out) результат победил — обмен принят.
      strictEqual(built.examples.length, 1);
      strictEqual(built.examples[0]?.metadata.task, 'freeship');
      deepStrictEqual(built.report.slugTaskConflicts, ['run']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
