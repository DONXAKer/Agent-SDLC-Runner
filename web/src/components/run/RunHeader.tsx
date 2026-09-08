import type { RunDetail } from '@sdlc-runner/shared';

import { fmtCost, fmtMoney } from '../../lib/format.ts';
import { tailPath } from '../../lib/paths.ts';
import { statusLabel, statusTone } from '../../lib/runStatus.ts';

/** Шапка страницы витка: идентичность, статус, стоимость, уведомления, отмена. */
export function RunHeader({
  detail,
  connected,
  alerts,
  stageRunning,
  confirmCancel,
  onConfirmCancel,
  onCancel,
  onExit,
}: {
  detail: RunDetail;
  connected: boolean;
  alerts: { supported: boolean; permission: NotificationPermission; enable: () => void };
  stageRunning: boolean;
  confirmCancel: boolean;
  onConfirmCancel: (v: boolean) => void;
  onCancel: () => void;
  onExit: () => void;
}): JSX.Element {
  return (
    <header className="flex items-center gap-4 border-b border-neutral-800 px-4 py-2.5">
      <button type="button" onClick={onExit} className="text-sm text-neutral-400 hover:text-neutral-200">
        ←
      </button>
      <div className="min-w-0">
        {/* Крошки: проект · slug одним моноширинным блоком — это идентичность витка,
            а не предложение. Полный корень не помещается в строку: хвост в тексте,
            целиком — в title. */}
        <div className="truncate text-sm font-medium">
          <span className="font-mono">
            {detail.project} · {detail.slug}
          </span>
        </div>
        <div className="truncate font-mono text-xs text-neutral-500" title={detail.projectRoot}>
          {tailPath(detail.projectRoot)}
        </div>
      </div>

      {/* Статус последнего этапа виден и здесь: пока он был только в списке витков,
          отменённый и упавший прогон на этой странице выглядели как простаивающий. */}
      <span
        className={`rounded border px-2 py-0.5 text-xs ${statusTone(detail.status, detail.stage)}`}
      >
        {statusLabel(detail.status, detail.stage)}
      </span>
      <span className="rounded bg-neutral-800 px-2 py-0.5 text-xs">профиль: {detail.profile}</span>
      <span className="text-xs text-neutral-500">
        chunk {detail.chunk} · попытка {detail.attempt} из {detail.attemptBudget}
        {/* Близость к прошлой попытке — число, а не вывод: утверждение «diff почти тот
            же» оператор должен иметь возможность проверить глазами. На первой попытке
            сравнивать не с чем, и ноль там был бы ложью. */}
        {detail.progressCloseness !== null ? (
          <span className={detail.progressCloseness >= detail.progressClosenessWarn ? ' text-amber-400' : ''}>
            {' '}
            · совпадение с прошлым патчем {Math.round(detail.progressCloseness * 100)}%
          </span>
        ) : null}
      </span>

      <div className="ml-auto flex items-center gap-4">
        {/*
          Расход против бюджета — снова в шапке, хотя подробные числа живут в «Метриках».
          Полная полоса `CostBar` ушла туда намеренно (наблюдательные числа не должны
          спорить за внимание с кнопкой отмены), но вместе с ней с рабочего экрана пропал
          ЕДИНСТВЕННЫЙ сигнал перерасхода: виток вставал сообщением «бюджет прогона
          исчерпан», а до того на «Сейчас» не было ни строки, ни цвета (ревью). Здесь —
          одна короткая величина: сумма и, при перерасходе, потолок красным.
        */}
        <span
          className={`text-xs ${
            detail.usage.costUsd !== null && detail.usage.costUsd >= detail.maxBudgetUsd
              ? 'font-medium text-red-400'
              : 'text-neutral-500'
          }`}
          title="Расход витка против бюджета проекта; разбивка — на вкладке «Метрики»"
        >
          {fmtCost(detail.usage, detail.currency)}
          {detail.usage.costUsd !== null && detail.usage.costUsd >= detail.maxBudgetUsd
            ? ` / ${fmtMoney(detail.maxBudgetUsd, detail.currency)}`
            : ''}
        </span>
        {/* При `denied` кнопки нет, и её отсутствие читалось как «уведомления включены»:
            оператор полагался на них и пропускал ожидание. Говорим прямо. */}
        {!alerts.supported || alerts.permission === 'denied' ? (
          <span
            className="text-xs text-neutral-500"
            title="Разрешение выдаётся в настройках сайта в браузере — со страницы его не запросить повторно."
          >
            уведомления недоступны
          </span>
        ) : null}

        {alerts.supported && alerts.permission === 'default' ? (
          <button
            type="button"
            onClick={alerts.enable}
            title="Сообщать в систему, когда виток встал и ждёт человека, пока вкладка не в фокусе"
            className="text-xs text-neutral-400 hover:text-neutral-200"
          >
            Включить уведомления
          </button>
        ) : null}

        {/* Кнопка есть ровно тогда, когда есть что обрывать — этап выполняется. По
            статусу решать нельзя: `done` рантайм ставит в конце КАЖДОГО этапа, и виток
            из семи этапов оставался бы без отмены после первого же успешного. Отмена
            при простое тоже вредна: она пометила бы `cancelled` вполне рабочий виток. */}
        {!stageRunning ? null : confirmCancel ? (
          <span className="flex items-center gap-1.5 text-xs">
            <span className="text-amber-300">Оборвать прогон?</span>
            <button
              type="button"
              onClick={onCancel}
              className="rounded border border-red-800 px-2 py-0.5 text-red-300 hover:bg-red-950"
            >
              Да, отменить
            </button>
            <button
              type="button"
              onClick={() => onConfirmCancel(false)}
              className="rounded border border-neutral-700 px-2 py-0.5 text-neutral-300 hover:bg-neutral-800"
            >
              Нет
            </button>
          </span>
        ) : (
          <button
            type="button"
            onClick={() => onConfirmCancel(true)}
            title="Остановить исполнителя. Уже записанные артефакты остаются на диске — это остановка, а не откат."
            className="rounded border border-neutral-700 px-2 py-0.5 text-xs text-neutral-300 hover:border-red-800 hover:text-red-300"
          >
            Отменить прогон
          </button>
        )}

        <span className={connected ? 'text-xs text-emerald-500' : 'text-xs text-amber-500'}>
          {connected ? 'онлайн' : 'переподключение…'}
        </span>
      </div>
    </header>
  );
}
