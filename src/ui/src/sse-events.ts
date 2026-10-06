export const SSE_EVENT_TYPES = [
  'agent.status_changed',
  'agent.output_updated',
  'agent.adopted',
  'agent.spawned',
  'agent.detached',
  'agent.killed',
  'agent.updated',
  'system.stop_all',
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
  'run.phase',
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
  'review.needs_reviewer',
  'peer.question',
  'peer.release',
  'peer.answer',
  'peer.failed',
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
  // Multi-orchestrator (identity, leases, liveness)
  'agent.reserved',
  'agent.released',
  'agent.lease_expired',
  'agent.runtime_relaunched',
  'task.waiting_for_agent',
  'user.created',
  'user.revoked',
  'profile.login_started',
  'profile.login_finished',
  'room.created',
  'room.doc_written',
  'room.report_added',
  'room.integrity_restored',
  'reply.feedback',
  'room.proposal_created',
  'room.proposal_promoted',
  'room.proposal_rejected',
  'retro.started',
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
  return (
    type === 'agent.adopted' ||
    type === 'agent.spawned' ||
    type === 'agent.restarted' ||
    type === 'agent.updated' ||
    type === 'agent.reserved' ||
    type === 'agent.released' ||
    type === 'agent.lease_expired' ||
    type === 'system.stop_all'
  );
}

export function shouldRefreshAgentOutput(type: string): boolean {
  return (
    type === 'agent.output_updated' ||
    type === 'agent.prompt_sent' ||
    type === 'agent.crashed' ||
    type === 'agent.restarted'
  );
}
