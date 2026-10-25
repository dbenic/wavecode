// @vitest-environment jsdom

import '../../test-setup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';

vi.mock('./useApi', () => ({
  useAuthState: () => ({ loaded: true, method: 'token', token: 'tok', tokenConfigured: true, unauthorized: false }),
  buildEventStreamUrl: (origin: string, lastEventId: number, token: string | null) => `${origin}/api/events?lastEventId=${lastEventId}&token=${token}`,
}));

import { useSSE, openEventStreams, resetEventStreamForTest, type SSEEvent } from './useSSE';

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  closed = false;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  listeners = new Map<string, (e: MessageEvent) => void>();
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (e: MessageEvent) => void) { this.listeners.set(type, fn); }
  close() { this.closed = true; }
  emit(type: string, event: SSEEvent) { this.listeners.get(type)?.({ data: JSON.stringify(event) } as MessageEvent); }
}

function Subscriber({ onEvent }: { onEvent: (e: SSEEvent) => void }) {
  useSSE(onEvent);
  return null;
}

let visibility: DocumentVisibilityState = 'visible';

beforeEach(() => {
  vi.useFakeTimers();
  FakeEventSource.instances = [];
  resetEventStreamForTest();
  (globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useSSE', () => {
  it('shares one stream between every subscriber in the tab and fans events out', () => {
    const a = vi.fn();
    const b = vi.fn();
    render(<><Subscriber onEvent={a} /><Subscriber onEvent={b} /></>);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(openEventStreams()).toBe(1);

    const ev: SSEEvent = { id: 7, type: 'agent.status_changed', entityType: 'agent', entityId: 'x', payload: null, createdAt: 'now' };
    act(() => FakeEventSource.instances[0].emit('agent.status_changed', ev));
    expect(a).toHaveBeenCalledWith(ev);
    expect(b).toHaveBeenCalledWith(ev);
  });

  it('closes the stream when the last subscriber unmounts', () => {
    const view = render(<Subscriber onEvent={vi.fn()} />);
    expect(openEventStreams()).toBe(1);
    view.unmount();
    expect(openEventStreams()).toBe(0);
    expect(FakeEventSource.instances[0].closed).toBe(true);
  });

  it('releases the connection a few seconds after the tab is hidden and resumes from the last event', () => {
    render(<Subscriber onEvent={vi.fn()} />);
    act(() => FakeEventSource.instances[0].emit('agent.status_changed', { id: 42, type: 'agent.status_changed', entityType: 'agent', entityId: 'x', payload: null, createdAt: 'now' }));

    visibility = 'hidden';
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(openEventStreams()).toBe(1); // not yet: a quick tab switch should not cost a reconnect
    act(() => { vi.advanceTimersByTime(5_000); });
    expect(openEventStreams()).toBe(0);

    visibility = 'visible';
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(openEventStreams()).toBe(1);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[1].url).toContain('lastEventId=42');
  });

  it('reconnects with backoff after an error', () => {
    render(<Subscriber onEvent={vi.fn()} />);
    act(() => { FakeEventSource.instances[0].onerror?.(); });
    expect(openEventStreams()).toBe(0);
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(openEventStreams()).toBe(1);
    expect(FakeEventSource.instances).toHaveLength(2);
  });
});
