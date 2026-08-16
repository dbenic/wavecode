/**
 * WaveCode MCP tool definitions.
 *
 * Data-driven so the handlers are unit-testable without an MCP transport:
 * each tool is {name, description, schema, handler(client, args)} and
 * registerWaveCodeTools() wires them onto an McpServer.
 *
 * The tool surface mirrors the REST API and the operating model documented
 * in docs/operating-model.md: dispatch work, watch agents, and drive the
 * review loop — external orchestrators (Grok, Claude, scripts) get exactly
 * the same levers as the web UI, including the promote gate.
 */

import { z, type ZodRawShape } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { WaveCodeClient } from './client.js';

export interface WaveCodeToolDef {
  name: string;
  description: string;
  schema: ZodRawShape;
  handler: (client: WaveCodeClient, args: Record<string, unknown>) => Promise<unknown>;
}

const EFFORT = z.enum(['low', 'medium', 'high', 'xhigh']);

export const WAVECODE_TOOLS: WaveCodeToolDef[] = [
  // --- Agents ---
  {
    name: 'list_agents',
    description:
      'List all registered agents with runtime, tmux session, status (idle/working/error), pinned model/effort, and last output line.',
    schema: {},
    handler: (client) => client.get('/agents'),
  },
  {
    name: 'spawn_agent',
    description:
      'Spawn a new CLI coding agent in a tmux session. Pin its LLM with model/effort so the pin is enforced at launch and checked at review time.',
    schema: {
      name: z.string().describe('Agent name (letters, numbers, dots, hyphens, underscores)'),
      runtime: z.string().describe("Runtime key from config, e.g. 'claude-code', 'codex', 'aider'"),
      model: z.string().optional().describe("Pinned model, e.g. 'claude-opus-5' or 'grok-4.6'"),
      effort: EFFORT.optional().describe('Pinned reasoning effort'),
      repo: z.string().optional().describe('Repo path — a dedicated git worktree is created'),
      branch: z.string().optional().describe('Branch for the worktree (default wc-<name>)'),
    },
    handler: (client, args) => client.post('/agents/spawn', args),
  },
  {
    name: 'pin_agent',
    description:
      "Update an agent's pinned model and/or effort level. Pass null to clear a pin. Applies on the agent's next (re)launch.",
    schema: {
      agent_id: z.string().describe('Agent ID or name'),
      model: z.string().nullable().optional(),
      effort: EFFORT.nullable().optional(),
    },
    handler: (client, args) =>
      client.patch(`/agents/${args.agent_id}`, { model: args.model, effort: args.effort }),
  },
  {
    name: 'kill_agent',
    description:
      "Kill a spawned agent: terminate its tmux session and remove it. Adopted agents can't be killed — detach them from the UI instead.",
    schema: { agent_id: z.string().describe('Agent ID or name') },
    handler: (client, args) => client.post(`/agents/${args.agent_id}/kill`),
  },
  {
    name: 'stop_all',
    description:
      'EMERGENCY STOP: kill every spawned agent, send Ctrl+C to adopted ones, and disable auto-dispatch until a human re-enables it.',
    schema: {},
    handler: (client) => client.post('/system/stop-all'),
  },
  {
    name: 'send_prompt',
    description: "Send a prompt (or instruction) directly into an agent's terminal session.",
    schema: {
      agent_id: z.string().describe('Agent ID or name'),
      text: z.string().describe('The prompt text to send'),
    },
    handler: (client, args) => client.post(`/agents/${args.agent_id}/send`, { text: args.text }),
  },
  {
    name: 'get_agent_output',
    description: "Read the last N lines of an agent's terminal output (default 50, max 500).",
    schema: {
      agent_id: z.string().describe('Agent ID or name'),
      lines: z.number().int().min(1).max(500).optional(),
    },
    handler: (client, args) =>
      client.get(`/agents/${args.agent_id}/output${args.lines ? `?lines=${args.lines}` : ''}`),
  },

  // --- Tasks ---
  {
    name: 'create_task',
    description:
      'Queue a task. Unassigned tasks go to any idle agent; depends_on task IDs build a DAG — dependents dispatch only after prerequisites finish (and are approved, when approval-gating is on).',
    schema: {
      prompt: z.string().describe('The task prompt'),
      agent_id: z.string().optional().describe('Assign to a specific agent (omit for any idle agent)'),
      priority: z.number().int().optional().describe('Higher dispatches first (default 0)'),
      depends_on: z.array(z.string()).optional().describe('Task IDs that must finish first'),
    },
    handler: (client, args) => client.post('/tasks', args),
  },
  {
    name: 'list_tasks',
    description: 'List tasks, optionally filtered by status (pending/running/done/failed/blocked).',
    schema: {
      status: z.enum(['pending', 'running', 'done', 'failed', 'blocked']).optional(),
    },
    handler: (client, args) =>
      client.get(`/tasks${args.status ? `?status=${args.status}` : ''}`),
  },

  // --- Review loop ---
  {
    name: 'list_reviews',
    description:
      'List runs awaiting human review. Each item includes the latest AI review verdict (pass/needs-fixes/reject) — promote is blocked without a pass unless an override reason is given.',
    schema: {},
    handler: (client) => client.get('/reviews'),
  },
  {
    name: 'request_ai_review',
    description:
      "Request a cross-model AI review of a run's diff by another agent (or the WaveCode LLM if no reviewer agent is given). The author never reviews its own work.",
    schema: {
      run_id: z.string(),
      reviewer_agent_id: z.string().optional().describe('Reviewing agent (must differ from the author)'),
    },
    handler: (client, args) =>
      client.post(`/reviews/${args.run_id}/ai-review`, {
        type: 'cross-model',
        reviewer_agent_id: args.reviewer_agent_id,
      }),
  },
  {
    name: 'get_ai_reviews',
    description: 'Get all AI reviews for a run: verdicts, issue counts, fix rounds, and full feedback.',
    schema: { run_id: z.string() },
    handler: (client, args) => client.get(`/reviews/${args.run_id}/ai-reviews`),
  },
  {
    name: 'promote_run',
    description:
      "Approve a run's work. Blocked unless the latest AI review verdict is 'pass'; supply override_reason to promote anyway (the reason is stored in the audit log).",
    schema: {
      run_id: z.string(),
      override_reason: z.string().optional().describe('Required when the verdict is not pass'),
    },
    handler: (client, args) =>
      client.post(`/reviews/${args.run_id}/promote`, { overrideReason: args.override_reason }),
  },
  {
    name: 'retry_run',
    description: 'Reject a run and re-queue its task on the same agent.',
    schema: { run_id: z.string() },
    handler: (client, args) => client.post(`/reviews/${args.run_id}/retry`),
  },
  {
    name: 'handoff_run',
    description: 'Reject a run and reassign its task to a different agent.',
    schema: { run_id: z.string(), target_agent_id: z.string() },
    handler: (client, args) =>
      client.post(`/reviews/${args.run_id}/handoff`, { targetAgentId: args.target_agent_id }),
  },
  {
    name: 'reject_run',
    description: "Reject a run and mark its task failed (dependents become blocked).",
    schema: { run_id: z.string() },
    handler: (client, args) => client.post(`/reviews/${args.run_id}/reject`),
  },

  // --- Events (real-time feedback) ---
  {
    name: 'await_events',
    description:
      'Block until something happens (or wait_seconds expires): run/task/review/message/agent events from the audit log. Pass the previous call\'s last_id as since_id to stream without gaps. Filter with types (exact or prefix wildcard, e.g. "run.*,review.*,message.created"). This is the real-time feedback channel for orchestrators: dispatch work, then await_events in a loop instead of polling.',
    schema: {
      since_id: z.number().int().min(0).optional().describe('Return only events after this id (use last_id from the previous call)'),
      wait_seconds: z.number().int().min(0).max(60).optional().describe('Long-poll up to this many seconds (default 0 = return immediately)'),
      types: z.string().optional().describe('Comma-separated type filters, * suffix for prefixes'),
      limit: z.number().int().min(1).max(500).optional(),
    },
    handler: (client, args) => {
      const params = new URLSearchParams();
      if (args.since_id) params.set('since', String(args.since_id));
      if (args.wait_seconds) params.set('wait_ms', String(Number(args.wait_seconds) * 1000));
      if (args.types) params.set('types', String(args.types));
      if (args.limit) params.set('limit', String(args.limit));
      const qs = params.toString();
      return client.get(`/events/log${qs ? `?${qs}` : ''}`);
    },
  },

  // --- Messages (the wire) ---
  {
    name: 'send_message',
    description:
      'Post a message on the agent wire (persisted + broadcast on SSE). Omit to_agent_id to broadcast to a workspace.',
    schema: {
      message: z.string(),
      to_agent_id: z.string().optional(),
      workspace: z.string().optional(),
      message_type: z.enum(['info', 'request', 'handoff', 'result', 'error']).optional(),
      ref_task_id: z.string().optional(),
      ref_run_id: z.string().optional(),
    },
    handler: (client, args) => client.post('/messages', args),
  },
  {
    name: 'list_messages',
    description: 'Read messages from the agent wire, optionally filtered by recipient or workspace.',
    schema: {
      to_agent_id: z.string().optional(),
      workspace: z.string().optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
    handler: (client, args) => {
      const params = new URLSearchParams();
      if (args.to_agent_id) params.set('to_agent_id', String(args.to_agent_id));
      if (args.workspace) params.set('workspace', String(args.workspace));
      if (args.limit) params.set('limit', String(args.limit));
      const qs = params.toString();
      return client.get(`/messages${qs ? `?${qs}` : ''}`);
    },
  },
];

/** Wire every WaveCode tool onto an MCP server instance. */
export function registerWaveCodeTools(server: McpServer, client: WaveCodeClient): void {
  for (const tool of WAVECODE_TOOLS) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.schema },
      async (args: Record<string, unknown>) => {
        try {
          const result = await tool.handler(client, args ?? {});
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
          };
        } catch (e) {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: `Error: ${(e as Error).message}` }],
          };
        }
      },
    );
  }
}
