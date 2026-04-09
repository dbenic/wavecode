export const SSE_EVENT_TYPES = [
  'agent.status_changed',
  'agent.output_updated',
  'agent.adopted',
  'agent.spawned',
  'agent.detached',
  'agent.prompt_sent',
  'agent.crashed',
  'agent.restarted',
  'agent.hung',
  'task.created',
  'task.dispatched',
  'task.completed',
  'task.failed',
  'task.blocked',
  'task.unblocked',
  'task.retrying',
  'run.started',
  'run.finished',
  'run.failed',
  'heartbeat',
  'artifact.created',
  'artifact.shared',
  'review.promoted',
  'review.retried',
  'review.handed_off',
  'review.rejected',
  'review.ai_started',
  'review.ai_completed',
  'review.fixes_sent',
  'queue.empty',
  'research.started',
  'research.chunk',
  'research.tool_use',
  'research.finished',
  'decision.created',
  'decision.deleted',
  'task.updated',
  'goal.created',
  'message.created',
] as const;

export type KnownSSEEventType = typeof SSE_EVENT_TYPES[number];

const SSE_EVENT_SET = new Set<string>(SSE_EVENT_TYPES);

export function isKnownSSEEventType(type: string): type is KnownSSEEventType {
  return SSE_EVENT_SET.has(type);
}

export function isTaskEventType(type: string): boolean {
  return type.startsWith('task.');
}

export function isReviewEventType(type: string): boolean {
  return type.startsWith('review.');
}

export function shouldReloadAgentList(type: string): boolean {
  return type === 'agent.adopted' || type === 'agent.spawned' || type === 'agent.restarted';
}

export function shouldRefreshAgentOutput(type: string): boolean {
  return (
    type === 'agent.output_updated' ||
    type === 'agent.prompt_sent' ||
    type === 'agent.crashed' ||
    type === 'agent.restarted'
  );
}
