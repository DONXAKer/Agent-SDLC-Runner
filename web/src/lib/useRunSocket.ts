import { useEffect, useRef, useState } from 'react';

import type { RunEvent } from './types.ts';

/**
 * Поток событий прогона. Сервер при подключении отдаёт историю, поэтому вкладка,
 * открытая посреди этапа, видит всё, что уже произошло, а не начинает с середины.
 */
export function useRunSocket(runId: string | null): {
  events: RunEvent[];
  connected: boolean;
} {
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const retry = useRef<number | null>(null);

  useEffect(() => {
    if (runId === null) {
      setEvents([]);
      return;
    }

    let closed = false;
    let socket: WebSocket | null = null;

    const open = (): void => {
      if (closed) return;
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      socket = new WebSocket(`${proto}://${location.host}/ws?runId=${encodeURIComponent(runId)}`);

      socket.onopen = () => setConnected(true);
      socket.onmessage = (m) => {
        try {
          setEvents((prev) => [...prev, JSON.parse(m.data as string) as RunEvent]);
        } catch {
          // Битое сообщение не должно ронять страницу.
        }
      };
      socket.onclose = () => {
        setConnected(false);
        if (!closed) retry.current = window.setTimeout(open, 1500);
      };
    };

    setEvents([]);
    open();

    return () => {
      closed = true;
      if (retry.current !== null) window.clearTimeout(retry.current);
      socket?.close();
    };
  }, [runId]);

  return { events, connected };
}
