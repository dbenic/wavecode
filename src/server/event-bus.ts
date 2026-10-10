import { insertEvent, listEvents, type WaveEvent } from './db.js';
import { currentActorId } from './request-context.js';

type SSEWriter = {
  write: (data: string) => void;
  close: () => void;
  id: string;
};

// Cap the number of events replayed on reconnect to avoid memory spikes
const MAX_REPLAY_EVENTS = 500;

// Cap max subscribers to prevent resource exhaustion
const MAX_SUBSCRIBERS = 100;

type EventListener = (event: WaveEvent) => void;
const listeners = new Set<EventListener>();

/** In-process subscription (the overlord, tests). Returns the unsubscribe function. Listeners never throw out of emit. */
export function onEvent(listener: EventListener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function resetEventListenersForTest(): void {
  listeners.clear();
}

const subscribers = new Set<SSEWriter>();

export function subscribe(writer: SSEWriter, lastEventId?: number): void {
  // Reject if at capacity
  if (subscribers.size >= MAX_SUBSCRIBERS) {
    writer.close();
    return;
  }

  subscribers.add(writer);

  // Replay missed events if client provides Last-Event-ID
  if (lastEventId && lastEventId > 0) {
    const missed = listEvents({ since_id: lastEventId, limit: MAX_REPLAY_EVENTS });
    for (const event of missed) {
      try {
        writer.write(formatSSE(event));
      } catch {
        subscribers.delete(writer);
        return;
      }
    }
  }
}

export function unsubscribe(writer: SSEWriter): void {
  subscribers.delete(writer);
}

export function getSubscriberCount(): number {
  return subscribers.size;
}

function formatSSE(event: WaveEvent): string {
  const data = {
    id: event.id,
    type: event.type,
    entityType: event.entity_type,
    entityId: event.entity_id,
    payload: event.payload_json ? JSON.parse(event.payload_json) : null,
    actorId: event.actor_id ?? null,
    createdAt: event.created_at,
  };
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Record and broadcast an event. `actor` is the user id that caused it:
 * omitted → the in-flight request's user (see request-context.ts), explicit
 * `null` → system.
 */
export function emit(
  type: string,
  entityType: string,
  entityId: string,
  payload?: Record<string, unknown>,
  actor?: string | { id: string } | null,
): WaveEvent | null {
  const actorId = actor === undefined
    ? currentActorId()
    : actor === null ? null : typeof actor === 'string' ? actor : actor.id;
  const result = insertEvent({ type, entity_type: entityType, entity_id: entityId, payload, actor_id: actorId });
  if (!result.ok) return null;

  const event = result.data;
  for (const l of listeners) {
    try { l(event); } catch { /* a listener must never break emit */ }
  }
  const message = formatSSE(event);

  // Collect dead writers to remove after iteration (safe Set mutation)
  const dead: SSEWriter[] = [];
  for (const writer of subscribers) {
    try {
      writer.write(message);
    } catch {
      dead.push(writer);
    }
  }
  for (const writer of dead) {
    subscribers.delete(writer);
  }

  return event;
}
