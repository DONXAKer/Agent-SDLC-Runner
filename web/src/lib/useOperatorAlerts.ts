import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Оповещение оператора о том, что виток встал и ждёт человека.
 *
 * Виток проводит в ожидании человека больше времени, чем в вычислениях, и всё это время
 * стоит молча — оператор узнаёт об ожидании, только вернувшись во вкладку. Поэтому:
 * счётчик в заголовке вкладки всегда, системное уведомление — когда страница не в фокусе.
 *
 * Покрыты ДВА вида ожидания из трёх: одобрение записи и вопрос агента. Приёмка (подпись
 * решения человека в артефакте) сюда не попадает: по ответу сервера не видно, записано
 * решение или ещё нет, а оповещать о том, что человек уже подписал, хуже, чем молчать.
 * Обещать здесь приёмку до того, как этот признак появится в контракте, нельзя.
 *
 * Повторов не будет: уже показанные запросы помнятся по их `id`, а лента событий при
 * переподключении сокета приходит заново целиком — без этой памяти каждое переподключение
 * заново оповещало бы обо всём, что уже видел человек.
 */

export interface WaitingItem {
  /** Идентификатор запроса — по нему считается «об этом уже оповещали». */
  id: string;
  text: string;
}

/** Больше трёх штук за раз — уже не оповещение, а спам; остаток виден в заголовке. */
const MAX_AT_ONCE = 3;

export function useOperatorAlerts({
  waiting,
  label,
}: {
  waiting: WaitingItem[];
  label: string;
}): { supported: boolean; permission: NotificationPermission; enable: () => void } {
  const supported = typeof window !== 'undefined' && 'Notification' in window;
  const [permission, setPermission] = useState<NotificationPermission>(
    supported ? Notification.permission : 'denied',
  );
  const notified = useRef<Set<string>>(new Set());
  const baseTitle = useRef(typeof document === 'undefined' ? '' : document.title);

  useEffect(() => {
    const base = baseTitle.current;
    document.title = waiting.length > 0 ? `(${waiting.length}) ${base}` : base;
    // Заголовок восстанавливается при уходе со страницы витка: счётчик чужого прогона в
    // заголовке стартового экрана — ложь о текущем состоянии.
    return () => {
      document.title = base;
    };
  }, [waiting.length]);

  /**
   * Показать то, о чём ещё не оповещали.
   *
   * Пометка «оповещено» ставится ТОЛЬКО после фактического показа: иначе оператор,
   * нажавший «Включить уведомления» на уже стоящем витке, не получит уведомления именно о
   * том запросе, из-за которого нажал, — id будет числиться показанным, не будучи им.
   */
  const flush = useCallback(() => {
    if (permission !== 'granted') return;
    // Страница в фокусе — оператор и так это видит; уведомление поверх собственного окна
    // только раздражает. Ушёл — сработает подписка на `blur` ниже.
    if (document.hasFocus()) return;

    const fresh = waiting.filter((w) => !notified.current.has(w.id));
    if (fresh.length === 0) return;

    // Помечается ТОЛЬКО фактически показанное, и сразу после показа. Пометка пачкой в
    // конце ломается двумя способами: хвост сверх `MAX_AT_ONCE` считался бы оповещённым
    // не будучи показан, а бросок конструктора отменял бы пометку и у тех, кого показать
    // успели, — и они сигналили бы заново на каждое событие сокета.
    for (const w of fresh.slice(0, MAX_AT_ONCE)) {
      try {
        new Notification(label, { body: w.text, tag: w.id });
      } catch {
        // Платформа объявляет `Notification`, но конструировать его не даёт — мобильный
        // Chrome умеет уведомления только через Service Worker. Молча не оповестить здесь
        // допустимо, а вот бросок из эффекта увёл бы всю страницу витка в белый экран:
        // границ ошибок в приложении нет.
        return;
      }
      notified.current.add(w.id);
    }

    // Чистки «по отсутствию в очереди» здесь намеренно НЕТ: очередь строится в том числе
    // из ленты событий, а лента обнуляется при каждом переподключении сокета. Запрос
    // временно исчезал из `waiting`, его id забывался, реплей возвращал тот же запрос — и
    // оператор получал повторное уведомление. Вместо этого память просто ограничена по
    // размеру: столько запросов витку не набрать, а рост на долгой странице закрыт.
    if (notified.current.size > 1000) {
      notified.current = new Set([...notified.current].slice(-500));
    }
  }, [waiting, label, permission]);

  useEffect(() => {
    flush();
  }, [flush]);

  // Запрос, появившийся при активной вкладке, дожидается ухода оператора: без этого он
  // не оповещался бы никогда — ни сейчас (фокус), ни потом (список `waiting` не менялся).
  useEffect(() => {
    window.addEventListener('blur', flush);
    return () => window.removeEventListener('blur', flush);
  }, [flush]);

  // Разрешение могли выдать или отозвать мимо нашей кнопки — в соседней вкладке или через
  // значок в адресной строке. Снимок, взятый один раз при монтировании, после этого врал.
  useEffect(() => {
    if (!supported) return;
    const sync = (): void => setPermission(Notification.permission);
    window.addEventListener('focus', sync);
    return () => window.removeEventListener('focus', sync);
  }, [supported]);

  const enable = useCallback(() => {
    if (!supported) return;
    try {
      // Обязательно `try`, а не только `.catch`: старые браузеры отдают колбэчную форму,
      // возвращающую `undefined`, и тогда `.then` бросает СИНХРОННО — до того, как в
      // цепочке появится `.catch`, так что тот подобное исключение не увидит вовсе.
      const asked = Notification.requestPermission();
      if (typeof asked?.then === 'function') {
        void asked.then(setPermission).catch(() => setPermission(Notification.permission));
      } else {
        // Колбэчная форма ответа не вернёт: перечитываем разрешение сами.
        setPermission(Notification.permission);
      }
    } catch {
      setPermission(Notification.permission);
    }
  }, [supported]);

  return { supported, permission, enable };
}
