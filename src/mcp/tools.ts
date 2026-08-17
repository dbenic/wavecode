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
      'Queue a task. Unassigned tasks go to any idle agent when auto_dispatch is on — pass agent_id to pin the assignee. depends_on builds a DAG. Optional goal_id (ULID or external_id like W0/G1) links a child to a seeded goal. Persist-only goals create no tasks; you add children yourself. hold:true skips auto-dispatch. After upload_artifact / share_artifact, put the artifact id and attached_path in the prompt so the implementer can open the file in their workspace — do not leave the file only in chat.',
    schema: {
      prompt: z.string().describe('The task prompt'),
      agent_id: z.string().optional().describe('Assign to a specific agent (omit for any idle agent)'),
      priority: z.number().int().optional().describe('Higher dispatches first (default 0)'),
      depends_on: z.array(z.string()).optional().describe('Task IDs that must finish first'),
      goal_id: z.string().optional().describe('Parent goal ULID or external_id (e.g. W0, G1)'),
      hold: z.boolean().optional().describe('If true, do not auto-dispatch this task'),
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
  {
    name: 'get_task',
    description:
      'Get one task plus its runs. Each run includes result_path / result / result_reason from the parseable per-run RESULT file (last line RESULT: PASS or RESULT: FAIL). Missing or unparseable is not PASS — do not infer success from idle, pane scrape, or duration.',
    schema: {
      task_id: z.string().describe('Task ULID'),
    },
    handler: (client, args) => client.get(`/tasks/${encodeURIComponent(String(args.task_id))}`),
  },

  // --- Goals (parent epics for decomposed task DAGs) ---
  {
    name: 'list_goals',
    description:
      'List persisted goals (big tasks / epics) with child-task rollup counts (pending/running/done/failed/blocked).',
    schema: {},
    handler: (client) => client.get('/goals'),
  },
  {
    name: 'get_goal',
    description:
      'Get one goal by id or external_id (e.g. F-16) plus child tasks and status rollup.',
    schema: {
      goal_id: z.string().describe('Goal ULID or optional external_id'),
    },
    handler: (client, args) => client.get(`/goals/${encodeURIComponent(String(args.goal_id))}`),
  },
  {
    name: 'create_goal',
    description:
      'Persist a goal. Default: LLM-decompose into a DAG of child tasks and dispatch. Set decompose:false or persist_only:true to record the row only (title, workspace, external_id) with no child tasks and no dispatch — use this to seed W0/G1 before assigning work. Optional external_id is a label (F-16, G1), not an import.',
    schema: {
      goal: z.string().optional().describe('High-level goal text (required unless persist-only + title)'),
      title: z.string().optional().describe('Short title (defaults to the goal text)'),
      workspace: z.string().optional(),
      external_id: z.string().optional().describe('Optional outside id such as F-16 or G1'),
      decompose: z.boolean().optional().describe('false = persist the goal row only; default true'),
      persist_only: z.boolean().optional().describe('Alias for decompose:false'),
    },
    handler: (client, args) => client.post('/goals', args),
  },

  // --- Artifacts (the share path: upload → attach → agent workspace) ---
  {
    name: 'list_artifacts',
    description:
      'List artifacts in the WaveCode store. Filter by agent_id to confirm the implementer has the file (created by or attached/shared to that agent). This is how CountixDev verifies a spec/PDF/screenshot landed after upload_artifact + share_artifact.',
    schema: {
      agent_id: z.string().optional().describe('Agent ID or name — created by or shared/attached to'),
      run_id: z.string().optional().describe('Source run ID'),
    },
    handler: (client, args) => {
      const params = new URLSearchParams();
      if (args.agent_id) params.set('agent_id', String(args.agent_id));
      if (args.run_id) params.set('run_id', String(args.run_id));
      const qs = params.toString();
      return client.get(`/artifacts${qs ? `?${qs}` : ''}`);
    },
  },
  {
    name: 'upload_artifact',
    description:
      'THE share path step 1: push a file from the orchestrator into WaveCode (not Grok Bot chat). Path (read by this MCP process) or content_base64 + filename. Pass agent_id to copy into that agent\'s .wavecode/artifacts workspace immediately (returns attached_path the CLI agent can open). Otherwise call share_artifact / attach_artifact next. Same hashed store as the PWA — no second store.',
    schema: {
      path: z.string().optional().describe('Local file path readable by the MCP process'),
      content_base64: z.string().optional().describe('File bytes as base64 (use when the daemon cannot see path)'),
      filename: z.string().optional().describe('Required with content_base64; defaults to path basename'),
      note: z.string().optional(),
      agent_id: z.string().optional().describe('Attach into this agent\'s workspace after upload'),
      run_id: z.string().optional().describe('Link as a run artifact (role=output on upload)'),
    },
    handler: async (client, args) => {
      const { readFileSync, existsSync } = await import('node:fs');
      const { basename } = await import('node:path');

      let contentBase64 = typeof args.content_base64 === 'string' ? args.content_base64 : undefined;
      let filename = typeof args.filename === 'string' ? args.filename : undefined;

      if (!contentBase64 && typeof args.path === 'string' && args.path.trim()) {
        const filePath = args.path.trim();
        if (!existsSync(filePath)) {
          throw new Error(`File not found: ${filePath}`);
        }
        contentBase64 = readFileSync(filePath).toString('base64');
        filename = filename || basename(filePath);
      }

      if (!contentBase64 || !filename) {
        throw new Error('Provide path, or content_base64 + filename');
      }

      return client.post('/artifacts/upload', {
        filename,
        content_base64: contentBase64,
        note: args.note,
        agent_id: args.agent_id,
        run_id: args.run_id,
      });
    },
  },
  {
    name: 'attach_artifact',
    description:
      'Quiet copy of an existing artifact into an agent workspace (.wavecode/artifacts + artifact_targets) and/or a run. Returns attached_path. Prefer share_artifact when handing a spec/PDF/screenshot to an implementer; use this when you only need the file on disk.',
    schema: {
      artifact_id: z.string().describe('Artifact ID'),
      agent_id: z.string().optional().describe('Copy into this agent\'s workspace'),
      run_id: z.string().optional().describe('Link to this run'),
      role: z.string().optional().describe('run_artifacts role when run_id is set (default input)'),
    },
    handler: (client, args) =>
      client.post(`/artifacts/${args.artifact_id}/attach`, {
        agent_id: args.agent_id,
        run_id: args.run_id,
        role: args.role,
      }),
  },
  {
    name: 'share_artifact',
    description:
      'THE share path step 2: hand an uploaded artifact to a target agent. Copies the file into that agent\'s .wavecode/artifacts workspace (CLI agent can open attached_path), records artifact_targets, and tries to notify the pane. File-on-disk is success even if notify fails. Then create_task with the id/path in the prompt, and list_artifacts(agent_id) to confirm.',
    schema: {
      artifact_id: z.string().describe('Artifact ID from upload_artifact'),
      agent_id: z.string().describe('Target agent ID or name (the implementer)'),
    },
    handler: (client, args) =>
      client.post(`/artifacts/${args.artifact_id}/share`, {
        agent_id: args.agent_id,
        targetAgentId: args.agent_id,
      }),
  },

  // --- Decisions (binding calls other agents must see) ---
  {
    name: 'list_decisions',
    description:
      'List recorded binding decisions, optionally filtered by workspace. Use this to see calls like routing or role-stripping rules.',
    schema: {
      workspace: z.string().optional().describe('Filter to one workspace path'),
    },
    handler: (client, args) =>
      client.get(`/decisions${args.workspace ? `?workspace=${encodeURIComponent(String(args.workspace))}` : ''}`),
  },
  {
    name: 'record_decision',
    description:
      'Record a binding decision other agents must honor (e.g. "employee view IS /incoming, stripped by role"). Requires workspace or an agent_id whose workspace is set.',
    schema: {
      summary: z.string().describe('Short binding statement'),
      workspace: z.string().optional().describe('Workspace path (required unless agent_id has one)'),
      detail: z.string().optional(),
      agent_id: z.string().optional().describe('Source agent; used to resolve workspace if omitted'),
    },
    handler: (client, args) => client.post('/decisions', args),
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
