/**
 * Прогон гейтов этапа 6.
 *
 * Порядок из методологии: **автоматические гейты идут перед ревью**, а не держатся на
 * промпте рецензента. Поэтому это отдельный шаг рантайма, а не инструмент, который
 * модель может забыть вызвать.
 *
 * Каждому включённому гейту «этап 6» соответствует ровно одна строка результата с именем
 * **дословно как в наборе** — сверка отчёта с набором идёт по именам, и склейка двух
 * гейтов в один лишила бы один из них статуса.
 */

import { readFileSync } from 'node:fs';

import type { GateRunResult, GateStatus } from '@sdlc-runner/shared';

import { worstGateStatus } from '@sdlc-runner/shared';

import type { GateContext } from './builtin/index.ts';
import { builtinFor, fullOutputOf, outputTailOf } from './builtin/index.ts';
import { CONTRACT_EXIT, CONTRACT_GLYPH, parseGateContract } from './contract.ts';
import type { GateRow, GatesFile } from './gatesFile.ts';
import { gateKey, gatesRunnableAtVerify, parseGates } from './gatesFile.ts';
import { missingTool } from './missingTool.ts';
import { runShell } from './shell.ts';
import { ensureSandboxFor } from '../sandbox/registry.ts';

export function loadGates(gatesPath: string): GatesFile {
  return parseGates(readFileSync(gatesPath, 'utf8'));
}

export interface RunGatesInput extends GateContext {
  gates: GatesFile;
  /**
   * Статусы гейтов, которые рантайм не исполняет сам: ревью независимым агентом даёт
   * статус прогоном субагента, ранние этапы — переносом со своего этапа. Ключ — имя
   * строки набора.
   */
  externalStatuses?: Readonly<Record<string, GateStatus>>;
  onResult?: (r: GateRunResult) => void;
  /** Сбой подготовки песочницы (напр. не удалось отключить сеть под `network: 'none'`) —
   * best-effort, не роняет прогон, но обязан дойти до оператора, а не только в stderr. */
  onWarn?: (message: string) => void;
  /**
   * Имя проекта из конфига (`ProjectConfig.name`) — идентификатор песочницы. ОБЯЗАНО
   * совпадать с именем, которым уже пользовался pre-flight (`sandbox/preflight.ts`):
   * разные имена — разные контейнеры, и гейты пойдут МИМО той песочницы, которую только
   * что проверили пробами.
   *
   * Поле было опциональным с фолбэком на `basename(projectRoot)` — фолбэк не срабатывал
   * НИ РАЗУ (единственный вызывающий, `Run.runVerifyGates`, всегда передавал явное имя), то
   * есть был мёртвым кодом, маскирующим реальный риск: молчаливое типами расхождение имён,
   * если будущий вызывающий забудет передать поле. Обязательность превращает этот класс
   * ошибки в отказ компиляции, а не в тихую утечку контейнера чужому проекту в рантайме.
   */
  projectName: string;
}

async function runOne(row: GateRow, i: RunGatesInput, ctx: GateContext): Promise<GateRunResult> {
  const started = Date.now();

  // Сопоставление по ключу, а не по точному имени: оператор пишет строку набора как
  // человек, а совпадать она обязана с тем же ключом, по которому её ищет диспетчеризация.
  const external = i.externalStatuses?.[gateKey(row.name)];
  if (external !== undefined) {
    return {
      name: row.name,
      status: external,
      command: null,
      exitCode: null,
      lastLine: `статус получен не скриптом: ${row.implementation || 'источник не назван'}`,
      durationMs: 0,
      // Не среда: статус пришёл из прогона субагента или иного внешнего источника.
      envBlocked: false,
    };
  }

  // Команда набора имеет приоритет над встроенной: проект, назвавший свою команду,
  // знает про себя больше, чем детект.
  //
  // `cwd: i.projectRoot` всегда, не по модулю: гейт из набора — ОДНА команда на проект
  // (например «cd backend && ./mvnw test»), а не список per-модуль команд, как у
  // встроенных «Сборка»/«Тесты» (`buildOne`/`testOne` там зовут `runShell` с
  // `join(ctx.projectRoot, mod.dir)` — реальная адресация по подкаталогу, на которую и
  // рассчитан `registry.ts::findSandboxForCwd`). Если проектная команда должна идти из
  // подкаталога — она сама пишет `cd` в начале, как в примере выше.
  if (row.command !== null) {
    const r = await runShell(row.command, {
      cwd: i.projectRoot,
      timeoutMs: i.timeoutMs,
      ...(i.signal === undefined ? {} : { signal: i.signal }),
    });
    // Отказ инструмента — не провал гейта. Методология (этап 6): «команда, упавшая на
    // отказ инструмента (`git: not found`, `java: command not found`), не даёт права
    // поставить ✅ — только ⏭: её код возврата свидетельствует о среде, а не о предмете
    // гейта». Раньше такая команда давала ❌ и роняла вердикт по причине, к работе витка
    // отношения не имеющей.
    // Средой считается ТОЛЬКО отсутствие инструмента. Таймаут — свойство самой команды
    // (её можно ускорить или поднять лимит), а отказ оператора — решение человека; ни то,
    // ни другое не «чинится на другой машине», и подмешивать их сюда значит объявлять
    // окружением всё, что не дошло до кода возврата.
    const output = fullOutputOf(r.stdout, r.stderr);
    const tails = output === '' ? {} : { outputTail: outputTailOf(r.stdout, r.stderr), output };
    const base = { name: row.name, command: row.command, exitCode: r.exitCode, durationMs: r.durationMs, ...tails };

    if (r.denied !== null || r.timedOut) {
      // Средой считается ТОЛЬКО отсутствие инструмента. Таймаут — свойство самой команды
      // (её можно ускорить или поднять лимит), а отказ пола безопасности — дефект набора;
      // ни то, ни другое не «чинится на другой машине».
      return {
        ...base,
        status: '⏭',
        lastLine: r.timedOut ? `команда не уложилась в ${i.timeoutMs} мс` : r.lastLine,
        envBlocked: false,
        missingTool: null,
        contract: 'exit-code',
      };
    }

    // Контракт гейт-скрипта (`contract.ts`): статус — по артефакту прогона, который скрипт
    // разобрал сам, а код возврата — зеркало. Скрипт, назвавший себя чужим именем, статуса
    // строке не даёт: сверка отчёта с набором идёт по именам, и подмена одного гейта другим
    // лишила бы строку проверки молча.
    const contract = parseGateContract(r.stdout);
    if (contract !== null) {
      const notes: string[] = [];
      if (gateKey(contract.gate) !== gateKey(row.name)) {
        return {
          ...base,
          status: '⏭',
          lastLine:
            `скрипт отчитался за гейт «${contract.gate}», а строка набора — «${row.name}»: статус не принят, ` +
            'почини имя в скрипте или в наборе',
          envBlocked: false,
          missingTool: null,
          contract: 'json',
          evidence: contract.evidence,
        };
      }
      let status: GateStatus = CONTRACT_GLYPH[contract.status];
      if (contract.missing_tool !== null && status === '✅') {
        // «Отказ инструмента среды — skip с missing_tool, никогда pass».
        status = '⏭';
        notes.push('контракт нарушен: pass вместе с missing_tool читается как skip');
      }
      const expected = CONTRACT_EXIT[contract.status];
      if (r.exitCode !== expected) {
        const byExit: GateStatus = r.exitCode === 0 ? '✅' : r.exitCode === 3 || r.exitCode === 2 ? '⏭' : '❌';
        status = worstGateStatus(status, byExit);
        notes.push(`код возврата ${r.exitCode ?? '—'} разошёлся с контрактом (${contract.status} → ${expected}) — взят худший`);
      }
      const envBlocked = status === '⏭' && contract.missing_tool !== null;
      const detail = contract.detail !== '' ? contract.detail : r.lastLine;
      return {
        ...base,
        status,
        lastLine:
          (envBlocked ? `инструмента нет в среде: ${contract.missing_tool} — ` : '') +
          detail +
          (contract.evidence.length > 0 ? ` · улик: ${contract.evidence.length}` : '') +
          (notes.length > 0 ? ` · ${notes.join('; ')}` : ''),
        envBlocked,
        missingTool: envBlocked ? contract.missing_tool : null,
        contract: 'json',
        evidence: contract.evidence,
      };
    }

    // Без JSON — прежнее правило по коду возврата: 0 — ✅, иначе ❌. Коды 2/3 контракта
    // действуют только у скриптов, печатающих JSON: у обычных команд это провал (`make`
    // отдаёт 2 на упавшей цели, `mocha` — число упавших тестов). Улика среды, а не догадка
    // по коду: строка оболочки обязана назвать сам инструмент команды
    // (`gates/missingTool.ts`) — «No such file or directory» из лога тестов, где тест
    // честно проверяет отсутствующий файл, средой не является.
    const missing = missingTool(output, row.command, r.exitCode);
    const envBlocked = missing !== null;
    const status: GateStatus = envBlocked ? '⏭' : r.exitCode === 0 ? '✅' : '❌';
    return {
      ...base,
      status,
      lastLine: missing !== null ? `инструмента нет в среде (код ${r.exitCode}): ${missing}` : r.lastLine,
      envBlocked,
      missingTool: missing,
      contract: 'exit-code',
    };
  }

  const builtin = builtinFor(row.name);
  if (builtin === null) {
    // Гейт включён, а исполнителя у него нет. Это `⏭`, и он уронит вердикт, если человек
    // не подпишет неприменимость — ровно тот случай, ради которого статус и заведён.
    return {
      name: row.name,
      status: '⏭',
      command: null,
      exitCode: null,
      lastLine:
        `гейт включён, но исполнить его нечем: в наборе нет команды в обратных кавычках, ` +
        `встроенной реализации под это имя тоже нет`,
      durationMs: 0,
      // Это дефект НАБОРА, а не среды: чинится правкой строки, а не другой машиной.
      envBlocked: false,
    };
  }

  const outcome = await builtin(ctx);
  // Признак среды берётся у исхода дословно: встроенная реализация знает, почему она не
  // смогла проверить, а восстанавливать это снаружи по паре «статус + код» — способ
  // разойтись молча (и он разошёлся: «найдены дубли хелперов» метилось как поломка машины).
  return {
    name: row.name,
    ...outcome,
    durationMs: Date.now() - started,
    envBlocked: outcome.envBlocked ?? false,
    // У встроенной реализации улика инструмента — её собственная: причину незапуска она
    // называет сама в `lastLine`, и только когда причина в среде (`envBlocked`). Явный
    // `missingTool: null` («раннер не обнаружен» — дефект набора, не среда) сохраняется как
    // есть: `??` подменял его на `lastLine` и давал ложный `blocked_env` (ревью).
    missingTool: outcome.missingTool !== undefined ? outcome.missingTool : outcome.envBlocked === true ? outcome.lastLine : null,
  };
}

/**
 * Гейты идут последовательно, а не параллельно: они делят рабочее дерево и git-индекс,
 * а сборка и тесты ещё и конкурируют за память. Выигрыш от параллельности здесь мнимый,
 * а взаимные помехи — настоящие.
 */
/**
 * Прогон ОДНОЙ строки набора по имени — тем же путём, что и весь набор на этапе 6.
 *
 * Нужен этапу 5, который записывает улику о тестах. Пока он звал `BUILTIN.get('Тесты')`
 * напрямую, он обходил приоритет команды из набора: проект, объявивший «Тесты» как
 * `./gradlew test`, получал в улике результат встроенного автодетекта — другой прогон,
 * другой каталог, иногда «тест-раннер не обнаружен». Файл при этом назывался «запись
 * рантайма о фактическом прогоне тестов этой попытки».
 *
 * `null` — строки с таким именем в наборе нет либо она выключена.
 */
export async function runGateByName(
  name: string,
  i: RunGatesInput,
  ctx: GateContext,
): Promise<GateRunResult | null> {
  const key = gateKey(name);
  const row = i.gates.rows.find((r) => gateKey(r.name) === key && r.enabled);
  if (row === undefined) return null;
  return runOne(row, i, ctx);
}

export async function runGates(i: RunGatesInput): Promise<GateRunResult[]> {
  // Готовим песочницу проекта ДО первого гейта — если у проекта есть `.sdlc/sandbox.json`,
  // «Сборка»/«Тесты» пойдут внутрь неё прозрачно через `runShell` (см. `sandbox/registry.ts`).
  // Нет спеки — `ensureSandboxFor` возвращает `null`, и всё идёт локальным путём, как раньше.
  // Сбой сборки образа НЕ роняет виток целиком: гейты просто останутся на локальном
  // исполнителе и упадут своей обычной красной строкой («java: not found» и т.п.) — это то
  // же самое состояние, что было до появления песочницы, а не новый класс отказа.
  try {
    await ensureSandboxFor(i.projectRoot, i.projectName, i.onWarn);
  } catch (e) {
    console.error(`[sandbox] песочница ${i.projectRoot} не поднялась: ${(e as Error).message}`);
  }

  // Контекст один на прогон и общий для всех гейтов: по нему кэшируется разбор diff'а
  // (`diffViolations`), который иначе тянут по разу «Анти-обход» и «Секреты». Пересоздание
  // контекста на каждый гейт обнуляло бы кэш, а модульный кэш по корню проекта пережил бы
  // прогон и отдал бы второй попытке находки первой.
  const ctx: GateContext = {
    projectRoot: i.projectRoot,
    planFiles: i.planFiles,
    baseline: i.baseline,
    timeoutMs: i.timeoutMs,
    ...(i.modules === undefined ? {} : { modules: i.modules }),
    ...(i.signal === undefined ? {} : { signal: i.signal }),
    ...(i.clarificationPath === undefined ? {} : { clarificationPath: i.clarificationPath }),
    // Вход резерва mutationCheckGate (ревью code-review-all, 2026-09-19): забытая копия
    // рядом с clarificationPath выше — на этапе verify гейт получал ctx.slug === undefined
    // и резервировал состояние в общий файл на весь projectRoot, а не под `.sdlc/<slug>/`.
    ...(i.slug === undefined ? {} : { slug: i.slug }),
    // Факты попытки для гейтов от базы (`overwrite.ts`, `baseCheck.ts`, `testsClaims.ts`).
    ...(i.baseSha === undefined ? {} : { baseSha: i.baseSha }),
    ...(i.attemptPatchPath === undefined ? {} : { attemptPatchPath: i.attemptPatchPath }),
    ...(i.claimIds === undefined ? {} : { claimIds: i.claimIds }),
    ...(i.journalPath === undefined ? {} : { journalPath: i.journalPath }),
    ...(i.testsCommand === undefined ? {} : { testsCommand: i.testsCommand }),
  };

  const out: GateRunResult[] = [];
  for (const row of gatesRunnableAtVerify(i.gates)) {
    if (i.signal?.aborted === true) break;
    const r = await runOne(row, i, ctx);
    out.push(r);
    i.onResult?.(r);
  }
  return out;
}
