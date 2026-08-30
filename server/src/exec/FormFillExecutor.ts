/**
 * Флоу `loop`, режим «заполнение бланка по полям» — для этапов-документов (1–4).
 *
 * Зачем: замеры (`docs/model-runs.md`) показали, что у моделей ≤9B порог «позвать
 * инструмент» лежит НИЖЕ порога «понять задачу»: qwen2.5-coder — 0 вызовов за 892 с,
 * qwen3.5 — три круга вопросов вместо записи. Этап-документ по существу — заполнение
 * разложенного рантаймом бланка, и tool-use для этого не обязателен: рантайм сам находит
 * плейсхолдеры `‹…›`, спрашивает модель ПО ОДНОМУ полю обычным completion'ом и сам
 * записывает результат. Порог «позвать инструмент» исчезает по построению.
 *
 * Что тут НЕ обходится:
 *  - **Гейт одобрения и политика.** Собранный артефакт уходит через `hooks.onToolRequest`
 *    нормализованным `Write` — тот же путь, что у salvage: политика решает, оператор
 *    одобряет, второго места решения о доступе не появляется.
 *  - **Страж завершения.** Поле, которое модель не смогла заполнить, остаётся
 *    плейсхолдером, и `finishGuard`/предусловия следующего этапа честно краснеют.
 *
 * Ограничение режима: `AskHuman` здесь нет — вопросы человеку требуют цикла. Поле,
 * требующее решения человека, модель обязана оставить с пометкой, а не сочинить; это
 * режим ЭКСПЕРИМЕНТА для слабых моделей (флаг `formFill` записи модели), а не замена
 * штатного цикла.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';

import type { Usage } from '@sdlc-runner/shared';
import { addUsage, emptyUsage } from '@sdlc-runner/shared';

import type { ChatProvider } from '../provider/ChatProvider.ts';
import { normalize } from './normalize.ts';
import type { ExecHooks, ExecRequest, StageExecutor, StageResult } from './StageExecutor.ts';
import { executeTool, type ToolContext } from './tools/index.ts';

export interface FormFillOptions {
  provider: ChatProvider;
  maxResultBytes: number;
  readRangeRequiredAboveBytes: number;
  bashTimeoutMs: number;
  /** Параметры запроса из конфига модели (`ModelDef.params`). */
  params?: Record<string, unknown> | null;
}

/** Плейсхолдер формы методологии. Тот же символ, которым считает `readArtifact`. */
const PLACEHOLDER = '‹';

/**
 * Ответ модели — строки, которыми заменяется строка бланка. Снимаются только обёртки,
 * которые модель добавляет «из вежливости» (fenced-блок, внешние кавычки) — содержимое
 * не редактируется: редактировать ответ значило бы сочинять артефакт за модель.
 */
export function cleanFieldAnswer(raw: string): string {
  let text = raw.trim();
  const fence = /^```[a-z]*\n([\s\S]*?)\n?```$/i.exec(text);
  if (fence !== null) text = fence[1]!.trim();
  if (text.startsWith('«') && text.endsWith('»')) text = text.slice(1, -1).trim();
  return text;
}

export class FormFillExecutor implements StageExecutor {
  readonly flow = 'loop' as const;
  private readonly o: FormFillOptions;

  constructor(o: FormFillOptions) {
    this.o = o;
  }

  async run(req: ExecRequest, hooks: ExecHooks): Promise<StageResult> {
    const artifacts = req.formArtifacts ?? [];
    if (artifacts.length === 0) {
      return {
        ok: false,
        finalText: '',
        usage: emptyUsage(),
        note: 'режим заполнения по полям: этап не назвал артефактов — исполнять нечего',
      };
    }

    const toolCtx: ToolContext = {
      projectRoot: req.cwd,
      maxResultBytes: this.o.maxResultBytes,
      readRangeRequiredAboveBytes: this.o.readRangeRequiredAboveBytes,
      timeoutMs: this.o.bashTimeoutMs,
      signal: req.signal,
    };

    let usage: Usage = emptyUsage();
    let fieldsFilled = 0;
    let fieldsLeft = 0;
    let callsSpent = 0;
    const notes: string[] = [];

    for (const path of artifacts) {
      if (req.signal.aborted) return { ok: false, finalText: '', usage, note: 'этап отменён' };

      let text: string;
      try {
        text = readFileSync(path, 'utf8');
      } catch {
        // Бланк не разложен — это дефект посева, а не модели: пропускаем с пометкой,
        // страж завершения назовёт незаписанный артефакт сам.
        notes.push(`бланк ${path} не найден — рантайм его не разложил`);
        continue;
      }

      const lines = text.split('\n');
      let changed = false;

      for (let n = 0; n < lines.length; n++) {
        const line = lines[n]!;
        if (!line.includes(PLACEHOLDER)) continue;

        // Потолок вызовов — тот же лимит ходов этапа: поле дешевле хода, но безлимитный
        // бланк на сотню плейсхолдеров съел бы больше, чем обычный цикл.
        if (callsSpent >= req.maxTurns) {
          fieldsLeft++;
          continue;
        }
        callsSpent++;

        const answer = await this.o.provider.chat({
          model: req.model,
          messages: [
            { role: 'system', content: req.prompt.system },
            {
              role: 'user',
              content: [
                req.prompt.user,
                '',
                '## Сейчас — ровно одно поле',
                '',
                `Файл \`${relative(req.cwd, path)}\`, строка бланка:`,
                '',
                '```',
                line,
                '```',
                '',
                'Верни строку (или строки), которыми надо ЗАМЕНИТЬ эту строку бланка, ' +
                  'целиком и без пояснений вокруг. Вместо `‹…›` — твоё содержимое по факту ' +
                  'задачи и входных артефактов. Если поле требует решения человека, которого ' +
                  'у тебя нет, верни строку с пометкой «требует решения человека: <что именно>» ' +
                  'вместо выдуманного ответа.',
              ].join('\n'),
            },
          ],
          tools: [],
          signal: req.signal,
          temperature: null,
          params: this.o.params ?? null,
        });

        usage = addUsage(usage, answer.usage);
        hooks.onUsage(answer.usage);

        const spent = usage.costUsd === null ? null : usage.costUsd + (req.spentUsdBefore ?? 0);
        if (req.maxBudgetUsd !== null && spent !== null && spent >= req.maxBudgetUsd) {
          return {
            ok: false,
            finalText: '',
            usage,
            note: `бюджет прогона исчерпан: $${spent.toFixed(4)} из $${req.maxBudgetUsd}`,
          };
        }

        const filled = cleanFieldAnswer(answer.text);
        // Пустой ответ и ответ с тем же плейсхолдером полем не считаются: строка остаётся
        // как была, и её честно назовут страж завершения и предусловие следующего этапа.
        if (filled === '' || filled.includes(PLACEHOLDER)) {
          fieldsLeft++;
          continue;
        }
        lines[n] = filled;
        fieldsFilled++;
        changed = true;
      }

      if (!changed) continue;

      // Запись — тем же путём, что любая запись исполнителя: нормализованный Write через
      // гейт. Отказ политики или оператора здесь окончательный — второй попытки с другим
      // путём у режима нет по построению.
      const rel = relative(req.cwd, path);
      const rawInput = { file_path: rel, content: lines.join('\n') };
      const call = normalize('Write', rawInput);
      const requestId = `form:${randomUUID()}`;
      const decision = await hooks.onToolRequest(call, {
        requestId,
        toolName: 'Write',
        rawInput,
        callerTools: req.allowedTools,
      });
      if (!decision.allowed) {
        hooks.onFriction('denied');
        hooks.onToolResult({ requestId, ok: false, summary: decision.reason, durationMs: 0 });
        notes.push(`запись ${rel} отклонена: ${decision.reason}`);
        continue;
      }
      const effective =
        decision.updatedInput === null
          ? call
          : normalize('Write', decision.updatedInput as Record<string, unknown>);
      const outcome = await executeTool(effective, toolCtx);
      hooks.onToolResult({
        requestId,
        ok: outcome.ok,
        summary: outcome.text.split('\n')[0]?.slice(0, 200) ?? '',
        durationMs: 0,
      });
      if (!outcome.ok) notes.push(`запись ${rel} не удалась: ${outcome.text}`);
    }

    const summary =
      `заполнение по полям: заполнено ${fieldsFilled}, осталось ${fieldsLeft}` +
      (notes.length === 0 ? '' : `; ${notes.join('; ')}`);
    hooks.onText(summary);

    // Последнее слово — за диском, как и в обычном цикле: страж смотрит артефакты, а не
    // наш счётчик полей.
    const complaint = req.finishGuard === null ? null : req.finishGuard();
    if (complaint !== null) {
      return { ok: false, finalText: summary, usage, note: complaint };
    }
    return { ok: true, finalText: summary, usage, note: summary };
  }
}
