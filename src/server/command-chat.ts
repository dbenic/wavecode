import { execFileSync } from 'node:child_process';
import { getConfig } from './config.js';
import {
  getDb, generateId, listAgents, getAgent, listTasks, listRuns, insertTask,
  type Agent, type Result,
} from './db.js';
import * as sessionManager from './session-manager.js';
import * as tmux from './tmux.js';
import { dispatchNext, addDependency } from './task-dispatcher.js';
import { requestSelfReview, requestCrossModelReview } from './code-review.js';
import * as teamManager from './team-manager.js';
import { shareFile } from './file-sharing.js';
import { getResolvedLlmConfig, isLlmConfigured, runToolConversation, type LlmToolDefinition } from './llm-provider.js';
import { startWatching } from './output-watcher.js';
import { emit } from './event-bus.js';

// --- DB helpers for chat ---

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  tool_calls: string | null;
  created_at: string;
}

export function ensureChatTable(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      tool_calls TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

export function insertChatMessage(role: 'user' | 'assistant', content: string, toolCalls?: string): ChatMessage {
  const id = generateId();
  getDb().prepare(
    'INSERT INTO chat_messages (id, role, content, tool_calls) VALUES (?, ?, ?, ?)'
  ).run(id, role, content, toolCalls ?? null);
  return getDb().prepare('SELECT * FROM chat_messages WHERE id = ?').get(id) as ChatMessage;
}

export function getChatHistory(limit: number = 50): ChatMessage[] {
  const rows = getDb().prepare(
    'SELECT * FROM chat_messages ORDER BY created_at DESC, rowid DESC LIMIT ?',
  ).all(limit) as ChatMessage[];

  return rows.reverse();
}

export function clearChatHistory(): void {
  getDb().prepare('DELETE FROM chat_messages').run();
}

interface DirectChatCommand {
  toolName: 'spawn_agent' | 'create_team' | 'handoff_file' | 'create_task_pipeline';
  input: Record<string, unknown>;
}

// --- Tool definitions for Claude ---

const TOOLS: LlmToolDefinition[] = [
  {
    name: 'spawn_agent',
    description: 'Create a new coding agent in a tmux session. Available runtimes are defined in config.yaml — common ones: claude-code, codex, aider, aider-qwen, aider-deepseek, aider-gpt-oss, aider-custom.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Agent name (lowercase, no spaces). E.g. "auth-refactor", "test-runner"' },
        runtime: { type: 'string', description: 'Which runtime to use. Check available runtimes in the system state below.' },
        repo: { type: 'string', description: 'Optional: path to git repo for worktree creation' },
        branch: { type: 'string', description: 'Optional: branch name for the worktree' },
      },
      required: ['name', 'runtime'],
    },
  },
  {
    name: 'list_agents',
    description: 'List all managed agents with their status, runtime, and current output.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'send_prompt',
    description: 'Send a text prompt/command to a specific agent via tmux.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        agent_name: { type: 'string', description: 'Agent name or ID' },
        text: { type: 'string', description: 'The prompt or command to send' },
      },
      required: ['agent_name', 'text'],
    },
  },
  {
    name: 'create_task',
    description: 'Create a single task. For multi-step work, call this multiple times and use depends_on to set execution order.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        prompt: { type: 'string', description: 'Detailed task prompt — be specific about what to do, which files, expected outcomes' },
        agent_name: { type: 'string', description: 'Optional: assign to a specific agent by name. Leave empty for auto-assignment to next idle agent' },
        priority: { type: 'number', description: 'Priority (higher = executed first). Default 0' },
        depends_on: { type: 'array', items: { type: 'string' }, description: 'Optional: array of task IDs that must complete before this task starts (DAG dependency)' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'create_task_pipeline',
    description: 'Create multiple tasks at once with automatic dependency chaining. Tasks execute in order — each waits for the previous one to finish. Use this for multi-step workflows.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              prompt: { type: 'string', description: 'Task prompt' },
              agent_name: { type: 'string', description: 'Optional: assign to specific agent' },
            },
            required: ['prompt'],
          },
          description: 'Ordered list of tasks — each depends on the previous one',
        },
        parallel: { type: 'boolean', description: 'If true, all tasks run in parallel (no dependencies). Default false (sequential chain).' },
      },
      required: ['tasks'],
    },
  },
  {
    name: 'list_tasks',
    description: 'List all tasks in the queue with their status, assigned agent, and dependencies.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'get_agent_output',
    description: 'Get the recent terminal output from an agent to see what it is doing.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        agent_name: { type: 'string', description: 'Agent name or ID' },
      },
      required: ['agent_name'],
    },
  },
  {
    name: 'create_team',
    description: 'Create a team/group for agent collaboration. Teams have shared file directories where agents can exchange specs, reviews, and messages. Agents in a team are briefed about their teammates and roles.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Team name (kebab-case). E.g. "ems-refactor", "api-redesign"' },
        description: { type: 'string', description: 'What this team is working on' },
        members: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              agent_name: { type: 'string' },
              role: { type: 'string', description: 'Role: implementer, reviewer, spec-writer, tester, lead, etc.' },
            },
            required: ['agent_name', 'role'],
          },
          description: 'Agents to add with their roles',
        },
      },
      required: ['name', 'description'],
    },
  },
  {
    name: 'list_teams',
    description: 'List all teams and their members.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'request_code_review',
    description: 'Request an AI code review for the last completed run of an agent. Can be self-review (same agent reviews own code) or cross-model (different model reviews). Cross-model captures the git diff and sends it to a reviewer.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        agent_name: { type: 'string', description: 'The agent whose code to review' },
        review_type: { type: 'string', enum: ['self', 'cross-model'], description: 'self = agent reviews own code, cross-model = different model reviews. Default: cross-model' },
        reviewer_agent: { type: 'string', description: 'Optional: specific agent to use as reviewer (for cross-model)' },
        reviewer_runtime: { type: 'string', description: 'Optional: runtime for the reviewer (e.g. aider-deepseek). Defaults to config.' },
      },
      required: ['agent_name'],
    },
  },
  {
    name: 'send_instruction',
    description: 'Send a detailed instruction, spec, or context to an agent. Use this to brief an agent on what to do — like sending an API spec, design doc, requirements, or output from another agent. The text is sent directly to the agent\'s terminal as a prompt.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        agent_name: { type: 'string', description: 'Target agent name' },
        instruction: { type: 'string', description: 'The full instruction/spec/context to send. Can be multi-line. Be detailed — this is what the agent will work from.' },
      },
      required: ['agent_name', 'instruction'],
    },
  },
  {
    name: 'handoff_file',
    description: 'Send a specific file from one agent to another. Gets the file path from the source agent\'s working directory and tells the target agent to read and act on it. Use for sharing specs, docs, schemas between agents.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        from_agent: { type: 'string', description: 'Agent that created/owns the file' },
        to_agent: { type: 'string', description: 'Agent to send the file to' },
        file_path: { type: 'string', description: 'Path to the file (relative to agent\'s working dir, or absolute)' },
        instruction: { type: 'string', description: 'What the target agent should do with the file. E.g. "Implement the API endpoints described in this spec"' },
      },
      required: ['from_agent', 'to_agent', 'file_path', 'instruction'],
    },
  },
  {
    name: 'get_agent_files',
    description: 'List recently changed files in an agent\'s working directory (git status). Use this to find out what files an agent created or modified.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        agent_name: { type: 'string', description: 'Agent name' },
      },
      required: ['agent_name'],
    },
  },
  {
    name: 'relay_between_agents',
    description: 'Take the recent output from one agent and send it to another agent with a custom instruction. Use this for handoffs: "take what agent A produced and tell agent B to review/test/extend it."',
    inputSchema: {
      type: 'object' as const,
      properties: {
        from_agent: { type: 'string', description: 'Agent to read output from' },
        to_agent: { type: 'string', description: 'Agent to send the context + instruction to' },
        instruction: { type: 'string', description: 'What the target agent should do with the context. E.g. "Review this API implementation and write tests for it"' },
        lines: { type: 'number', description: 'How many lines of output to capture from source agent. Default 50.' },
      },
      required: ['from_agent', 'to_agent', 'instruction'],
    },
  },
  {
    name: 'add_decision',
    description: 'Record an architectural decision for a workspace/codebase. Decisions are included in context briefings sent to all agents working on that codebase. Use this when the user says "remember that...", "we decided to...", "use X instead of Y", etc.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        agent_name: { type: 'string', description: 'Agent whose workspace this decision applies to. The decision will be shared with all agents on the same workspace.' },
        summary: { type: 'string', description: 'One-line summary of the decision (max 100 chars). Start with a verb: "Use...", "Prefer...", "Store..."' },
        detail: { type: 'string', description: 'Optional: brief elaboration on the reasoning' },
      },
      required: ['agent_name', 'summary'],
    },
  },
  {
    name: 'list_decisions',
    description: 'List architectural decisions for an agent\'s workspace.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        agent_name: { type: 'string', description: 'Agent name — lists decisions for its workspace' },
      },
      required: ['agent_name'],
    },
  },
];

// --- Tool execution ---

async function executeTool(name: string, input: Record<string, unknown>): Promise<string> {
  switch (name) {
    case 'spawn_agent': {
      const result = sessionManager.spawnAgent({
        name: input.name as string,
        runtime: input.runtime as Agent['runtime'],
        repo: input.repo as string | undefined,
        branch: input.branch as string | undefined,
      });
      if (!result.ok) return `Error: ${result.error}`;
      const agent = result.data;

      // Start output watcher so agent appears on dashboard
      startWatching(agent.id);
      emit('agent.spawned', 'agent', agent.id, {
        name: agent.name,
        runtime: agent.runtime,
      });

      return `✓ Spawned agent "${agent.name}" (${agent.runtime}) in tmux session ${agent.tmux_session}. Workspace: ${agent.workspace ?? 'unknown'}`;
    }

    case 'list_agents': {
      const agents = listAgents();
      if (agents.length === 0) return 'No agents managed. Use spawn_agent to create one.';
      return agents.map((a) => {
        // Get the working directory from the last output or workspace
        const captureResult = sessionManager.capturePane(a.tmux_session, 3);
        let workDir = a.workspace ?? '';
        if (!workDir && captureResult.ok) {
          // Try to extract path from Codex status bar or shell prompt
          const dirMatch = captureResult.data.match(/~\/[\w/.-]+/);
          if (dirMatch) workDir = dirMatch[0];
        }
        return `• ${a.name} [${a.runtime}] — ${a.status} | dir: ${workDir || 'unknown'} (${a.mode})`;
      }).join('\n');
    }

    case 'send_prompt': {
      const agentResult = sessionManager.get(input.agent_name as string);
      if (!agentResult.ok) return `Error: ${agentResult.error}`;
      const sendResult = sessionManager.sendKeys(agentResult.data.id, input.text as string);
      if (!sendResult.ok) return `Error: ${sendResult.error}`;
      return `✓ Sent prompt to ${agentResult.data.name}.`;
    }

    case 'create_task': {
      let agentId: string | undefined;
      if (input.agent_name) {
        const agentResult = sessionManager.get(input.agent_name as string);
        if (!agentResult.ok) return `Error: ${agentResult.error}`;
        agentId = agentResult.data.id;
      }
      const result = insertTask({
        prompt: input.prompt as string,
        agent_id: agentId,
        priority: (input.priority as number) ?? 0,
      });
      if (!result.ok) return `Error: ${result.error}`;

      // Add dependencies if specified
      const deps = input.depends_on as string[] | undefined;
      if (deps && deps.length > 0) {
        for (const depId of deps) {
          addDependency(result.data.id, depId);
        }
      }

      setTimeout(() => dispatchNext(), 500);
      const depInfo = deps?.length ? ` (depends on: ${deps.join(', ')})` : '';
      return `✓ Task ${result.data.id}${agentId ? ` → ${input.agent_name}` : ' (auto-assign)'}${depInfo}: ${(input.prompt as string).substring(0, 80)}`;
    }

    case 'create_task_pipeline': {
      const tasks = input.tasks as { prompt: string; agent_name?: string }[];
      const parallel = input.parallel as boolean ?? false;
      const created: { id: string; prompt: string }[] = [];

      for (let i = 0; i < tasks.length; i++) {
        const t = tasks[i];
        let agentId: string | undefined;
        if (t.agent_name) {
          const agentResult = sessionManager.get(t.agent_name);
          if (agentResult.ok) agentId = agentResult.data.id;
        }

        const result = insertTask({
          prompt: t.prompt,
          agent_id: agentId,
          priority: tasks.length - i, // Higher priority for earlier tasks
        });

        if (!result.ok) return `Error creating task ${i + 1}: ${result.error}`;

        // Chain dependency: each task depends on the previous one (unless parallel)
        if (!parallel && i > 0 && created.length > 0) {
          addDependency(result.data.id, created[i - 1].id);
        }

        created.push({ id: result.data.id, prompt: t.prompt.substring(0, 60) });
      }

      setTimeout(() => dispatchNext(), 500);

      const lines = created.map((t, i) => {
        const arrow = !parallel && i > 0 ? '  ↳ ' : '  ';
        return `${arrow}${i + 1}. [${t.id}] ${t.prompt}`;
      });

      return `✓ Pipeline created (${created.length} tasks, ${parallel ? 'parallel' : 'sequential'}):\n${lines.join('\n')}`;
    }

    case 'list_tasks': {
      const tasks = listTasks();
      if (tasks.length === 0) return 'No tasks in the queue.';
      const agents = listAgents();
      const agentMap = new Map(agents.map((a) => [a.id, a.name]));
      return tasks.map((t) => {
        const prompt = t.prompt.length > 50 ? t.prompt.substring(0, 47) + '...' : t.prompt;
        const agent = t.agent_id ? agentMap.get(t.agent_id) ?? '?' : 'auto';
        return `• [${t.status}] ${prompt} → ${agent} (pri:${t.priority}, id:${t.id.substring(0, 8)})`;
      }).join('\n');
    }

    case 'get_agent_output': {
      const agentResult = sessionManager.get(input.agent_name as string);
      if (!agentResult.ok) return `Error: ${agentResult.error}`;
      const captureResult = sessionManager.capturePane(agentResult.data.tmux_session, 30);
      if (!captureResult.ok) return `Error: ${captureResult.error}`;
      const output = captureResult.data.trim();
      return output || '(no output captured)';
    }

    case 'create_team': {
      const result = teamManager.createTeam(
        input.name as string,
        input.description as string,
      );
      if (!result.ok) return `Error: ${result.error}`;

      const team = result.data;
      const memberResults: string[] = [];

      // Add members
      const members = input.members as { agent_name: string; role: string }[] | undefined;
      if (members) {
        for (const m of members) {
          const agentResult = sessionManager.get(m.agent_name);
          if (!agentResult.ok) {
            memberResults.push(`⚠ ${m.agent_name}: ${agentResult.error}`);
            continue;
          }
          const addResult = teamManager.addMember(team.id, agentResult.data.id, m.role);
          if (addResult.ok) {
            memberResults.push(`✓ ${m.agent_name} → ${m.role}`);
          } else {
            memberResults.push(`⚠ ${m.agent_name}: ${addResult.error}`);
          }
        }
      }

      // Start comms watcher
      teamManager.startCommsWatcher(input.name as string);

      return `✓ Team "${input.name}" created.\n\nMembers:\n${memberResults.join('\n') || '(none yet)'}\n\nShared directory: teams/${input.name}/\nAgents have been briefed about their team and roles.`;
    }

    case 'list_teams': {
      const teams = teamManager.listTeams();
      if (teams.length === 0) return 'No teams created yet. Use create_team to set one up.';
      return teams.map((t) => {
        const members = teamManager.getTeamMembers(t.id);
        const memberList = members.map((m) => `  - ${m.agent_name} (${m.role})`).join('\n');
        return `• ${t.name}: ${t.description}\n${memberList || '  (no members)'}`;
      }).join('\n\n');
    }

    case 'request_code_review': {
      const agentResult = sessionManager.get(input.agent_name as string);
      if (!agentResult.ok) return `Error: ${agentResult.error}`;

      // Find the latest run for this agent
      const runs = listRuns({ agent_id: agentResult.data.id });
      const latestRun = runs[0];

      if (!latestRun) {
        // No formal run — just send a self-review prompt directly
        const sendResult = sessionManager.sendKeys(agentResult.data.id,
          'Review your recent changes. Check for bugs, security issues, missing tests. Start with "REVIEW:"');
        return sendResult.ok
          ? `✓ Sent self-review prompt to ${agentResult.data.name} (no formal run found — reviewing current state).`
          : `Error: ${sendResult.error}`;
      }

      const reviewType = (input.review_type as string) ?? 'cross-model';
      if (reviewType === 'self') {
        const result = await requestSelfReview(latestRun.id);
        return result.ok ? `✓ Self-review started for ${agentResult.data.name}. Review ID: ${result.data.id}` : `Error: ${result.error}`;
      } else {
        let reviewerAgentId: string | undefined;
        if (input.reviewer_agent) {
          const r = sessionManager.get(input.reviewer_agent as string);
          if (r.ok) reviewerAgentId = r.data.id;
        }
        const result = await requestCrossModelReview(latestRun.id, reviewerAgentId, input.reviewer_runtime as string | undefined);
        return result.ok
          ? `✓ Cross-model review started. Review ID: ${result.data.id}. Reviewer: ${input.reviewer_runtime ?? 'LLM direct'}. Check Review Queue for feedback.`
          : `Error: ${result.error}`;
      }
    }

    case 'send_instruction': {
      const agentResult = sessionManager.get(input.agent_name as string);
      if (!agentResult.ok) return `Error: ${agentResult.error}`;
      const instruction = input.instruction as string;
      const sendResult = sessionManager.sendKeys(agentResult.data.id, instruction);
      if (!sendResult.ok) return `Error: ${sendResult.error}`;
      return `✓ Sent instruction to ${agentResult.data.name} (${instruction.length} chars). The agent is now processing it.`;
    }

    case 'handoff_file': {
      const fromResult = sessionManager.get(input.from_agent as string);
      if (!fromResult.ok) return `Error (from): ${fromResult.error}`;
      const toResult = sessionManager.get(input.to_agent as string);
      if (!toResult.ok) return `Error (to): ${toResult.error}`;

      // Determine category from instruction keywords
      const instruction = input.instruction as string;
      const lowerInstr = instruction.toLowerCase();
      const category = lowerInstr.includes('review') ? 'review' as const
        : lowerInstr.includes('context') || lowerInstr.includes('reference') ? 'context' as const
        : 'spec' as const;

      const result = shareFile({
        fromAgentId: fromResult.data.id,
        toAgentId: toResult.data.id,
        filePath: input.file_path as string,
        category,
        purpose: instruction,
      });

      if (!result.ok) return `Error: ${result.error}`;

      const sf = result.data;
      return `✓ Shared "${sf.filename}" (v${sf.version}) from ${sf.from_agent_name} → ${sf.to_agent_name}\n  Category: ${sf.category}\n  Location in target project: .wavecode/shared-${sf.category}s/${sf.filename}\n  Agent notified and manifest updated.`;
    }

    case 'get_agent_files': {
      const agentResult = sessionManager.get(input.agent_name as string);
      if (!agentResult.ok) return `Error: ${agentResult.error}`;

      try {
        const paneDir = tmux.getPaneDir(agentResult.data.tmux_session);
        if (!paneDir) return 'Error: cannot determine agent working directory';

        let gitStatus = '';
        try {
          gitStatus = execFileSync('git', ['-C', paneDir, 'status', '--short'], {
            encoding: 'utf-8', timeout: 5000,
          }).trim();
        } catch { /* not a git repo */ }

        let recentFiles = '';
        try {
          recentFiles = execFileSync('git', ['-C', paneDir, 'log', '--name-only', '--pretty=format:', '-5'], {
            encoding: 'utf-8', timeout: 5000,
          }).trim();
        } catch { /* no git history */ }

        return `Working dir: ${paneDir}\n\nModified/new files:\n${gitStatus || '(clean)'}\n\nRecently committed:\n${recentFiles || '(none)'}`;
      } catch (e) {
        return `Error getting files: ${(e as Error).message}`;
      }
    }

    case 'relay_between_agents': {
      // Get output from source agent
      const fromResult = sessionManager.get(input.from_agent as string);
      if (!fromResult.ok) return `Error (from): ${fromResult.error}`;
      const toResult = sessionManager.get(input.to_agent as string);
      if (!toResult.ok) return `Error (to): ${toResult.error}`;

      const captureLines = (input.lines as number) ?? 50;
      const captureResult = sessionManager.capturePane(fromResult.data.tmux_session, captureLines);
      if (!captureResult.ok) return `Error capturing output: ${captureResult.error}`;

      // Build the relay message
      const context = captureResult.data.trim();
      const instruction = input.instruction as string;
      const relayMessage = `${instruction}\n\nContext from ${fromResult.data.name}:\n---\n${context}\n---`;

      const sendResult = sessionManager.sendKeys(toResult.data.id, relayMessage);
      if (!sendResult.ok) return `Error sending to ${toResult.data.name}: ${sendResult.error}`;

      return `✓ Relayed ${captureLines} lines from ${fromResult.data.name} → ${toResult.data.name} with instruction: "${instruction.substring(0, 80)}"`;
    }

    case 'add_decision': {
      const agentResult = sessionManager.get(input.agent_name as string);
      if (!agentResult.ok) return `Error: ${agentResult.error}`;
      const agent = agentResult.data;
      if (!agent.workspace) return `Error: Agent "${agent.name}" has no workspace. Decisions require a workspace.`;

      const { insertDecision } = await import('./db.js');
      const result = insertDecision({
        workspace: agent.workspace,
        summary: (input.summary as string).slice(0, 200),
        detail: (input.detail as string | undefined)?.slice(0, 500) ?? null,
        source_agent_id: agent.id,
      });

      if (!result.ok) return `Error: ${result.error}`;

      emit('decision.created', 'decision', result.data.id, {
        workspace: agent.workspace,
        summary: result.data.summary,
        agent_name: agent.name,
      });

      return `✓ Decision recorded for workspace ${agent.workspace}: "${result.data.summary}"`;
    }

    case 'list_decisions': {
      const agentResult = sessionManager.get(input.agent_name as string);
      if (!agentResult.ok) return `Error: ${agentResult.error}`;
      const agent = agentResult.data;
      if (!agent.workspace) return `No workspace for agent "${agent.name}".`;

      const { listDecisions: listDec } = await import('./db.js');
      const decisions = listDec(agent.workspace);

      if (decisions.length === 0) return `No decisions recorded for workspace ${agent.workspace}.`;

      return decisions.map((d, i) => {
        const detail = d.detail ? ` — ${d.detail}` : '';
        return `${i + 1}. ${d.summary}${detail}`;
      }).join('\n');
    }

    default:
      return `Unknown tool: ${name}`;
  }
}

function hasExplicitSpawnIntent(message: string): boolean {
  return /\b(spawn|start|create|launch|open|spin\s+up)\b/i.test(message);
}

function unquote(value: string): string {
  return value.replace(/^["']|["']$/g, '').trim();
}

function resolveRuntimeFromMessage(message: string, availableRuntimes: string[]): Agent['runtime'] | null {
  const matches = new Set<string>();

  const runtimePatterns = availableRuntimes.flatMap((runtime) => {
    const patterns = [runtime, runtime.replace(/-/g, ' ')];

    if (runtime === 'claude-code') {
      patterns.push('claude', 'claude code');
    }

    return patterns.map((pattern) => ({ runtime, pattern }));
  });

  for (const { runtime, pattern } of runtimePatterns) {
    const escaped = pattern
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\s+/g, '\\s+');
    const regex = new RegExp(`\\b${escaped}\\b`, 'i');
    if (regex.test(message)) {
      matches.add(runtime);
    }
  }

  if (matches.size !== 1) {
    return null;
  }

  return [...matches][0] as Agent['runtime'];
}

function extractAgentNameFromMessage(message: string): string | null {
  const patterns = [
    /\b(?:named|called)\s+["']?([a-zA-Z0-9._-]{1,64})["']?/i,
    /\bname(?:\s+it)?\s+["']?([a-zA-Z0-9._-]{1,64})["']?/i,
    /\b(?:spawn|start|create|launch|open|spin\s+up)\s+(?:an?\s+)?(?:(?:new|another)\s+)?(?:(?:agent|session|worker)\s+)?["']?([a-zA-Z0-9._-]{1,64})["']?\s+(?:using|with|on|in)\b/i,
    /\b(?:spawn|start|create|launch|open|spin\s+up)\s+(?:an?\s+)?(?:[a-zA-Z0-9-]+\s+)?(?:agent|session|worker)\s+["']?([a-zA-Z0-9._-]{1,64})["']?/i,
  ];

  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }

  return null;
}

function extractRepoPathFromMessage(message: string): string | undefined {
  const match = message.match(
    /\brepo\s+(?:"([^"]+)"|'([^']+)'|([^\s]+))(?=\s+\b(?:branch|named|called|using|with)\b|$)/i,
  );

  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  return value ? unquote(value) : undefined;
}

function extractBranchFromMessage(message: string): string | undefined {
  const match = message.match(/\bbranch\s+["']?([a-zA-Z0-9._/-]+)["']?/i);
  return match?.[1];
}

function extractTeamNameFromMessage(message: string): string | null {
  const patterns = [
    /\bteam\s+(?:named|called)\s+["']?([a-zA-Z0-9._-]{1,64})["']?/i,
    /\bcreate\s+(?:a\s+)?team\s+["']?([a-zA-Z0-9._-]{1,64})["']?/i,
  ];

  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }

  return null;
}

function extractTeamDescription(message: string): string {
  const match = message.match(/\bfor\s+(.+?)(?=\s+\bwith\b|$)/i);
  return match?.[1]?.trim() ?? '';
}

function extractTeamMembers(message: string): { agent_name: string; role: string }[] {
  const withIndex = message.search(/\bwith\b/i);
  if (withIndex === -1) {
    return [];
  }

  const membersText = message.slice(withIndex);
  return [...membersText.matchAll(/\b([a-zA-Z0-9._-]+)\s+as\s+([a-zA-Z0-9._-]+)\b/gi)]
    .map((match) => ({
      agent_name: match[1],
      role: match[2],
    }));
}

function inferSharedFileCategory(fileRef: string): 'spec' | 'review' | 'context' | 'output' {
  const normalized = fileRef.toLowerCase();
  if (normalized.includes('review')) return 'review';
  if (normalized.includes('context')) return 'context';
  if (normalized.includes('output')) return 'output';
  return 'spec';
}

function resolveHandoffFileRef(fileRef: string): {
  filePath: string;
  category: 'spec' | 'review' | 'context' | 'output';
} {
  const normalized = fileRef.trim().toLowerCase();

  if (normalized === 'spec' || normalized === 'the spec') {
    return { filePath: 'docs/spec.md', category: 'spec' };
  }

  return {
    filePath: unquote(fileRef.trim()),
    category: inferSharedFileCategory(fileRef),
  };
}

function defaultHandoffInstruction(category: 'spec' | 'review' | 'context' | 'output'): string {
  switch (category) {
    case 'review':
      return 'Read this review feedback and apply it to your work.';
    case 'context':
      return 'Read this shared context and use it in your implementation.';
    case 'output':
      return 'Read this shared output and continue the work from it.';
    case 'spec':
    default:
      return 'Read this specification carefully and implement from it.';
  }
}

function extractTaskGraphBody(message: string): string | null {
  const colonIndex = message.indexOf(':');
  if (colonIndex !== -1) {
    const body = message.slice(colonIndex + 1).trim();
    if (body) return body;
  }

  const newlineIndex = message.indexOf('\n');
  if (newlineIndex !== -1) {
    const body = message.slice(newlineIndex + 1).trim();
    if (body) return body;
  }

  return null;
}

function parseTaskGraphItems(body: string): { prompt: string; agent_name?: string }[] {
  const segments = body.includes('->')
    ? body.split(/\s*->\s*/g)
    : body
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);

  const tasks: { prompt: string; agent_name?: string }[] = [];

  for (const rawSegment of segments) {
    const segment = rawSegment
      .replace(/^[*-]\s*/, '')
      .replace(/^\d+[.)]\s*/, '')
      .trim();

    if (!segment) continue;

    const assignedMatch = segment.match(/^([a-zA-Z0-9._-]+)\s*:\s*(.+)$/);
    if (assignedMatch) {
      tasks.push({
        agent_name: assignedMatch[1],
        prompt: assignedMatch[2].trim(),
      });
      continue;
    }

    tasks.push({ prompt: segment });
  }

  return tasks;
}

function tryParseCreateTeamCommand(userMessage: string): DirectChatCommand | null {
  if (!/\bcreate\s+(?:a\s+)?team\b/i.test(userMessage)) {
    return null;
  }

  const name = extractTeamNameFromMessage(userMessage);
  if (!name) {
    return null;
  }

  return {
    toolName: 'create_team',
    input: {
      name,
      description: extractTeamDescription(userMessage),
      members: extractTeamMembers(userMessage),
    },
  };
}

function tryParseHandoffCommand(userMessage: string): DirectChatCommand | null {
  const match = userMessage.match(
    /\b(?:handoff|share|send)\s+(.+?)\s+from\s+([a-zA-Z0-9._-]+)\s+to\s+([a-zA-Z0-9._-]+)(?:\s+(?:and\s+tell\s+(?:it|them)\s+to|for)\s+(.+))?$/i,
  );
  if (!match) {
    return null;
  }

  const fileRef = match[1].trim();
  const fromAgent = match[2];
  const toAgent = match[3];
  const resolved = resolveHandoffFileRef(fileRef);
  const instruction = match[4]?.trim() || defaultHandoffInstruction(resolved.category);

  return {
    toolName: 'handoff_file',
    input: {
      from_agent: fromAgent,
      to_agent: toAgent,
      file_path: resolved.filePath,
      instruction,
    },
  };
}

function tryParseTaskGraphCommand(userMessage: string): DirectChatCommand | null {
  if (!/\b(?:create|build|make)\s+(?:a\s+)?(?:dependent\s+)?task\s+graph\b/i.test(userMessage)) {
    return null;
  }

  const body = extractTaskGraphBody(userMessage);
  if (!body) {
    return null;
  }

  const tasks = parseTaskGraphItems(body);
  if (tasks.length === 0) {
    return null;
  }

  return {
    toolName: 'create_task_pipeline',
    input: {
      tasks,
      parallel: false,
    },
  };
}

function tryParseDirectCommand(userMessage: string): DirectChatCommand | null {
  const createTeamCommand = tryParseCreateTeamCommand(userMessage);
  if (createTeamCommand) {
    return createTeamCommand;
  }

  const handoffCommand = tryParseHandoffCommand(userMessage);
  if (handoffCommand) {
    return handoffCommand;
  }

  const taskGraphCommand = tryParseTaskGraphCommand(userMessage);
  if (taskGraphCommand) {
    return taskGraphCommand;
  }

  if (!hasExplicitSpawnIntent(userMessage)) {
    return null;
  }

  const config = getConfig();
  const runtime = resolveRuntimeFromMessage(userMessage, Object.keys(config.runtimes));
  const name = extractAgentNameFromMessage(userMessage);

  if (!runtime || !name) {
    return null;
  }

  return {
    toolName: 'spawn_agent',
    input: {
      name,
      runtime,
      repo: extractRepoPathFromMessage(userMessage),
      branch: extractBranchFromMessage(userMessage),
    },
  };
}

async function tryHandleDirectCommand(userMessage: string): Promise<{ reply: string; toolCalls: string[] } | null> {
  const directCommand = tryParseDirectCommand(userMessage);
  if (!directCommand) {
    if (hasExplicitSpawnIntent(userMessage)) {
      const config = getConfig();
      const runtimes = Object.keys(config.runtimes).join(', ');
      return {
        reply: `I detected an agent creation request, but I could not parse both the runtime and the name. Try: "start a codex agent named co-builder" or "create an agent named api-reviewer using claude-code". Available runtimes: ${runtimes}.`,
        toolCalls: [],
      };
    }
    return null;
  }

  insertChatMessage('user', userMessage);

  const toolResult = await executeTool(directCommand.toolName, directCommand.input);
  const toolCalls = [`${directCommand.toolName}: ${toolResult}`];

  insertChatMessage(
    'assistant',
    toolResult,
    JSON.stringify(toolCalls),
  );

  return {
    reply: toolResult,
    toolCalls,
  };
}

// --- Main chat function ---

export async function chat(userMessage: string): Promise<{ reply: string; toolCalls: string[] }> {
  const directCommandResult = await tryHandleDirectCommand(userMessage);
  if (directCommandResult) {
    return directCommandResult;
  }

  if (!isLlmConfigured()) {
    const llm = getResolvedLlmConfig();
    return {
      reply: llm.provider === 'anthropic'
        ? 'LLM not configured. Go to Settings and add your Anthropic API key to enable the chat.'
        : 'LLM not configured. Go to Settings and set a model plus an OpenAI-compatible base URL or API key to enable the chat.',
      toolCalls: [],
    };
  }

  const config = getConfig();

  // --- @mention preprocessing ---
  // Detect @agent-name patterns and resolve to real agent names
  const agents = listAgents();
  const agentNames = agents.map((a) => a.name);
  const mentionRegex = /@([\w-]+)/g;
  const mentions: string[] = [];
  let processedMessage = userMessage;

  let match;
  while ((match = mentionRegex.exec(userMessage)) !== null) {
    const mentioned = match[1];
    // Find matching agent (exact or partial match)
    const found = agentNames.find((name) =>
      name === mentioned || name.startsWith(mentioned)
    );
    if (found) {
      mentions.push(found);
    }
  }

  // If @mentions found, add context to help the LLM use the right tools
  if (mentions.length > 0) {
    const mentionContext = mentions.map((name) => {
      const agent = agents.find((a) => a.name === name);
      return agent ? `@${name} → agent "${name}" (${agent.runtime}, ${agent.status})` : '';
    }).filter(Boolean).join('\n');

    processedMessage = `${userMessage}\n\n[Mentioned agents: ${mentions.join(', ')}. Use send_instruction or handoff_file tools to send content to these agents. If the user asks to "write X and send to @agent", first compose the content, then use send_instruction to deliver it.]`;
  }

  // Save user message (original, without processing metadata)
  insertChatMessage('user', userMessage);

  // Build conversation from history — but replace the last user message with the processed version
  // (which includes @mention context the LLM needs to act on)
  const history = getChatHistory(30);
  const messages = history.map((m) => ({
    role: m.role as 'user' | 'assistant',
    content: m.content,
  }));
  // Replace the last message (which is the raw userMessage from DB) with processedMessage
  if (messages.length > 0 && processedMessage !== userMessage) {
    messages[messages.length - 1] = { role: 'user', content: processedMessage };
  }

  const currentAgents = listAgents();
  const currentTasks = listTasks();
  const pendingTasks = currentTasks.filter((t) => t.status === 'pending').length;
  const runningTasks = currentTasks.filter((t) => t.status === 'running').length;

  // Build agent context with directories
  const agentContext = currentAgents.map((a) => {
    const captureResult = sessionManager.capturePane(a.tmux_session, 3);
    let workDir = a.workspace ?? '';
    if (!workDir && captureResult.ok) {
      const dirMatch = captureResult.data.match(/~\/[\w/.-]+/);
      if (dirMatch) workDir = dirMatch[0];
    }
    return `  • ${a.name} [${a.runtime}] — ${a.status} — dir: ${workDir || 'unknown'}`;
  }).join('\n');

  const systemPrompt = `You are WaveCode's AI Project Manager. You help orchestrate coding work across CLI agents running in tmux sessions.

## @Mentions

Users can tag agents with @name in their messages. When you see @agent-name:
- **Direct command**: "@cl-edge refactor the auth" → use send_instruction to send to cl-edge immediately
- **Write and send**: "Write a spec and send to @cl-frontend" → compose the content, then use send_instruction to deliver it
- **Multiple mentions**: "@cl-backend write it, @co-edge review it" → send to both agents with appropriate instructions
- **If @mention is ambiguous**, ask which agent they mean

When @mentions are present, ACT ON THEM — don't just plan. The user expects the content to be sent.

## Agent Assignment Rules

Each agent works in a SPECIFIC project directory. You MUST:
1. For explicit creation requests like "start a codex agent named foo", call spawn_agent immediately
2. When NO @mention: call list_agents first, suggest the right agent, ask for confirmation
3. When @mention present: use that agent directly — user already chose
4. **Suggest spawning a new agent** if no existing agent matches the project

## Workflow

- With @mention: compose content → send to mentioned agent(s) → confirm what was sent
- Without @mention: break down work → show agents → ask which to use → create tasks after confirmation

## Task Prompts

Write each task prompt as a clear briefing:
- Specific files and functions to work on
- Expected behavior / test criteria
- One clear objective per task

## Tools
- **list_agents** — ALWAYS call first to see agents + directories
- **create_task_pipeline** — multi-step work with auto-chaining
- **create_task** — single task, supports depends_on for DAG
- **spawn_agent** — new agent (claude-code / codex / aider) with repo path
- **send_prompt** — direct command to an agent's terminal
- **list_tasks** / **get_agent_output** — check status

## Current Agents
${agentContext || '  (none)'}

## Current Tasks
- ${currentTasks.length} total (${pendingTasks} pending, ${runningTasks} running)

## Runtimes: ${Object.keys(config.runtimes).join(', ')}`;

  const toolCalls: string[] = [];

  const chatResult = await runToolConversation({
    systemPrompt,
    messages,
    tools: TOOLS,
    maxTokens: 2048,
    onToolCall: executeTool,
  });

  if (!chatResult.ok) {
    return {
      reply: chatResult.error,
      toolCalls: [],
    };
  }

  toolCalls.push(...chatResult.data.toolCalls);
  const reply = chatResult.data.reply || 'Done.';

  // Save assistant reply
  insertChatMessage('assistant', reply, toolCalls.length > 0 ? JSON.stringify(toolCalls) : undefined);

  return { reply, toolCalls };
}
