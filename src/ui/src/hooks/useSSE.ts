import { useEffect, useRef } from 'react';
import { buildEventStreamUrl, useAuthState } from './useApi';
import { SSE_EVENT_TYPES, type KnownSSEEventType } from '../sse-events';

export interface SSEEvent {
  id: number;
  type: KnownSSEEventType | string;
  entityType: string;
  entityId: string;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

type EventHandler = (event: SSEEvent) => void;

export function useSSE(onEvent: EventHandler) {
  const lastEventIdRef = useRef<number>(0);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const auth = useAuthState();

  useEffect(() => {
    if (!auth.loaded) return;
    if (auth.method === 'token' && !auth.token) return;

    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout>;
    let reconnectDelay = 1000; // Start at 1s, exponential backoff

    function connect() {
      es = new EventSource(
        buildEventStreamUrl(window.location.origin, lastEventIdRef.current, auth.token),
      );

      es.onopen = () => {
        reconnectDelay = 1000; // Reset backoff on successful connect
      };

      es.onerror = () => {
        es?.close();
        // Exponential backoff: 1s, 2s, 4s, 8s, max 30s
        reconnectTimer = setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, 30000);
      };

      for (const type of SSE_EVENT_TYPES) {
        es.addEventListener(type, (e: MessageEvent) => {
          try {
            const data = JSON.parse(e.data) as SSEEvent;
            lastEventIdRef.current = data.id;
            onEventRef.current(data);
          } catch {
            // Ignore parse errors
          }
        });
      }

    }

    connect();

    return () => {
      clearTimeout(reconnectTimer);
      es?.close();
    };
  }, [auth.loaded, auth.method, auth.token]);
}
