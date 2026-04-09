import { describe, expect, it } from 'vitest';
import {
  SSE_EVENT_TYPES,
  isKnownSSEEventType,
  isReviewEventType,
  isTaskEventType,
  shouldRefreshAgentOutput,
  shouldReloadAgentList,
} from './sse-events';

describe('sse-events', () => {
  it('tracks the event types subscribed by the frontend', () => {
    expect(SSE_EVENT_TYPES).toContain('agent.output_updated');
    expect(SSE_EVENT_TYPES).toContain('task.dispatched');
    expect(SSE_EVENT_TYPES).toContain('review.ai_completed');
  });

  it('recognizes known SSE event types', () => {
    expect(isKnownSSEEventType('agent.status_changed')).toBe(true);
    expect(isKnownSSEEventType('task.completed')).toBe(true);
    expect(isKnownSSEEventType('unknown.event')).toBe(false);
  });

  it('classifies task and review events', () => {
    expect(isTaskEventType('task.retrying')).toBe(true);
    expect(isTaskEventType('review.retried')).toBe(false);
    expect(isReviewEventType('review.handed_off')).toBe(true);
    expect(isReviewEventType('run.finished')).toBe(false);
  });

  it('identifies agent list reload events', () => {
    expect(shouldReloadAgentList('agent.adopted')).toBe(true);
    expect(shouldReloadAgentList('agent.spawned')).toBe(true);
    expect(shouldReloadAgentList('agent.detached')).toBe(false);
  });

  it('identifies output refresh events', () => {
    expect(shouldRefreshAgentOutput('agent.output_updated')).toBe(true);
    expect(shouldRefreshAgentOutput('agent.prompt_sent')).toBe(true);
    expect(shouldRefreshAgentOutput('agent.crashed')).toBe(true);
    expect(shouldRefreshAgentOutput('task.completed')).toBe(false);
  });
});
