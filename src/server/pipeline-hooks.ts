/**
 * Sync call-ins for the hands-free pipeline. The pipeline module registers
 * these when it loads. Callers stay free of that import so the modules do
 * not cycle. Unregistered hooks do nothing, which is the default.
 */

export const pipelineHooks = {
  onFreeze: null as ((sha: string) => void) | null,
  onAuthorDone: null as ((agentId: string) => void) | null,
  onMain: null as ((project: string, sha: string) => void) | null,
  onDeployed: null as ((releaseId: string) => void) | null,
  onVerified: null as ((project: string | null) => void) | null,
};

function fire(fn: (() => void) | null): void {
  if (!fn) return;
  try { fn(); } catch { /* the pipeline logs its own failures */ }
}

export function fireFreeze(sha: string): void {
  fire(pipelineHooks.onFreeze ? () => pipelineHooks.onFreeze!(sha) : null);
}

export function fireAuthorDone(agentId: string): void {
  fire(pipelineHooks.onAuthorDone ? () => pipelineHooks.onAuthorDone!(agentId) : null);
}

export function fireMainAdvanced(project: string, sha: string): void {
  fire(pipelineHooks.onMain ? () => pipelineHooks.onMain!(project, sha) : null);
}

export function fireStagingDeployed(releaseId: string): void {
  fire(pipelineHooks.onDeployed ? () => pipelineHooks.onDeployed!(releaseId) : null);
}

export function fireStagingVerified(project: string | null): void {
  fire(pipelineHooks.onVerified ? () => pipelineHooks.onVerified!(project) : null);
}
