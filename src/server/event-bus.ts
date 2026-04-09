import { insertEvent, listEvents, type WaveEvent } from './db.js';

type SSEWriter = {
  write: (data: string) => void;
  close: () => void;
  id: string;
};

// Cap the number of events replayed on reconnect to avoid memory spikes
const MAX_REPLAY_EVENTS = 500;

// Cap max subscribers to prevent resource exhaustion
const MAX_SUBSCRIBERS = 100;

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
    createdAt: event.created_at,
  };
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function emit(
  type: string,
  entityType: string,
  entityId: string,
  payload?: Record<string, unknown>,
): WaveEvent | null {
  const result = insertEvent({ type, entity_type: entityType, entity_id: entityId, payload });
  if (!result.ok) return null;

  const event = result.data;
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
