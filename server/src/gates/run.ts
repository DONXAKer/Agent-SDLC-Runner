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

import type { GateContext } from './builtin/index.ts';
import { builtinFor } from './builtin/index.ts';
import type { GateRow, GatesFile } from './gatesFile.ts';
import { gateKey, gatesRunnableAtVerify, parseGates } from './gatesFile.ts';
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
    const envBlocked = toolMissing(r.exitCode, r.lastLine);
    const status: GateStatus =
      r.denied !== null || r.timedOut || envBlocked ? '⏭' : r.exitCode === 0 ? '✅' : '❌';
    return {
      name: row.name,
      status,
      command: row.command,
      exitCode: r.exitCode,
      lastLine: r.timedOut
        ? `команда не уложилась в ${i.timeoutMs} мс`
        : toolMissing(r.exitCode, r.lastLine)
          ? `инструмента нет в среде (код ${r.exitCode}): ${r.lastLine}`
          : r.lastLine,
      durationMs: r.durationMs,
      envBlocked,
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

/**
 * Код возврата, означающий «инструмента нет», а не «проверка провалилась».
 *
 * 127 — команда не найдена, 126 — найдена, но не исполняется, 9009 — то же самое от
 * командного процессора Windows. Отличать это от настоящего провала обязала методология:
 * иначе отсутствие `java` в контейнере роняет вердикт витка, который к java не имеет
 * отношения.
 */
function toolMissing(exitCode: number | null, lastLine: string): boolean {
  if (exitCode === 127 || exitCode === 126 || exitCode === 9009) return true;
  // Windows-`cmd` на отсутствующую команду отдаёт код 1 — по нему её не отличить от
  // настоящего провала, — но пишет узнаваемую строку. По-русски она приходит в чужой
  // кодировке и признаком служить не может: там гейт останется ❌, и это ограничение
  // названо, а не замаскировано подгонкой под мусорные байты.
  return /is not recognized as an internal or external command/i.test(lastLine);
}
