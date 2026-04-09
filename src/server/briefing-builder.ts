import {
  type Agent,
  type Task,
  getAgent,
  getAgentsByWorkspace,
  getRecentRunsForWorkspace,
  listDecisions,
} from './db.js';
import logger from './logger.js';

/**
 * Token budget for the briefing block.
 * ~4 chars per token → 800 tokens ≈ 3200 chars.
 */
const MAX_BRIEFING_CHARS = 3200;

/**
 * Build a context briefing to prepend to a task prompt before dispatching.
 *
 * The briefing gives the agent awareness of:
 * - Other agents working on the same codebase
 * - Recent file changes by sibling agents
 * - Architectural decisions made during the project
 *
 * Returns null if there's nothing useful to include (solo agent, no history).
 */
export function buildBriefing(agent: Agent, task: Task): string | null {
  if (!agent.workspace) return null;

  const sections: string[] = [];

  // 1. Sibling agents on same workspace
  const siblings = getAgentsByWorkspace(agent.workspace)
    .filter((a) => a.id !== agent.id);

  if (siblings.length > 0) {
    const agentLines = siblings.map((s) => {
      const statusIcon = s.status === 'working' ? '🔨' : s.status === 'error' ? '❌' : '💤';
      return `- ${s.name} (${s.runtime}) — ${statusIcon} ${s.status.toUpperCase()}`;
    });
    sections.push(`### Sibling Agents (same codebase)\n${agentLines.join('\n')}`);
  }

  // 2. Recent runs and file changes
  const recentRuns = getRecentRunsForWorkspace(agent.workspace, 8);
  const otherRuns = recentRuns.filter((r) => r.agent_id !== agent.id);

  if (otherRuns.length > 0) {
    const changeLines: string[] = [];

    for (const run of otherRuns.slice(0, 5)) {
      let files: string[] = [];
      if (run.changed_files) {
        try { files = JSON.parse(run.changed_files) as string[]; } catch { /* ignore */ }
      }

      const ago = timeAgo(run.finished_at ?? run.started_at);
      const taskPreview = run.task_prompt.slice(0, 80).replace(/\n/g, ' ');

      if (files.length > 0) {
        const fileList = files.slice(0, 5).map((f) => `\`${f}\``).join(', ');
        const extra = files.length > 5 ? ` +${files.length - 5} more` : '';
        changeLines.push(`- ${run.agent_name}: ${fileList}${extra} (${ago}) — "${taskPreview}"`);
      } else if (run.status === 'done') {
        changeLines.push(`- ${run.agent_name}: completed task (${ago}) — "${taskPreview}"`);
      }
    }

    if (changeLines.length > 0) {
      sections.push(`### Recent Changes by Other Agents\n${changeLines.join('\n')}`);
    }
  }

  // 3. Decisions
  const decisions = listDecisions(agent.workspace);
  if (decisions.length > 0) {
    const decisionLines = decisions.slice(0, 10).map((d) => {
      const detail = d.detail ? ` — ${d.detail}` : '';
      return `- ${d.summary}${detail}`;
    });
    sections.push(`### Architectural Decisions\n${decisionLines.join('\n')}`);
  }

  if (sections.length === 0) return null;

  let briefing = `## WAVECODE BRIEFING\n> Auto-generated context from your orchestrator. Read before starting.\n\n${sections.join('\n\n')}`;

  // Trim to budget if needed
  if (briefing.length > MAX_BRIEFING_CHARS) {
    briefing = briefing.slice(0, MAX_BRIEFING_CHARS - 20) + '\n\n[...truncated]';
  }

  logger.debug({ agentId: agent.id, briefingLength: briefing.length }, 'Built context briefing');

  return briefing;
}

/**
 * Build a preview of what the briefing would look like for a given agent.
 * Used by the UI to show users the context before dispatch.
 */
export function previewBriefing(agentId: string, taskPrompt: string): string | null {
  const agentResult = getAgent(agentId);
  if (!agentResult.ok) return null;

  const agent = agentResult.data;
  const fakeTask: Task = {
    id: 'preview',
    agent_id: agentId,
    prompt: taskPrompt,
    status: 'pending',
    priority: 0,
    created_at: new Date().toISOString(),
  };

  return buildBriefing(agent, fakeTask);
}

function timeAgo(isoDate: string): string {
  const diffMs = Date.now() - new Date(isoDate).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
