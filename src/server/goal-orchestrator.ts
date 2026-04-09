import { completeText } from './llm-provider.js';
import { insertTask, listAgents, type Task, type Agent, type Result } from './db.js';
import { addDependency, dispatchNext } from './task-dispatcher.js';
import { emit } from './event-bus.js';
import logger from './logger.js';

export interface GoalPlan {
  goal: string;
  tasks: GoalTask[];
  created_task_ids: string[];
}

interface GoalTask {
  title: string;
  prompt: string;
  agent_hint?: string;
  depends_on_indices?: number[];
  priority?: number;
}

interface DecomposedPlan {
  tasks: GoalTask[];
}

function buildSystemPrompt(agents: Agent[]): string {
  const agentList = agents
    .map((a) => `- ${a.name} (runtime: ${a.runtime}, workspace: ${a.workspace ?? 'none'}, status: ${a.status})`)
    .join('\n');

  return `You are a task decomposition engine for a multi-agent coding platform.

Given a high-level goal, break it into concrete sub-tasks that coding agents can execute independently.

Available agents:
${agentList}

Rules:
- Create 2-8 tasks. Each must be actionable by a single coding agent.
- Each task prompt must be self-contained — include all context the agent needs.
- Use depends_on_indices to create a DAG (e.g., "implement API" depends on "design schema").
- Indices are 0-based and refer to positions in your tasks array.
- Do not create circular dependencies.
- Set agent_hint to match the best agent by name or runtime type.
- Priority: 10 = critical path, 0 = nice to have.
- Order tasks logically — foundations first.
- Output ONLY valid JSON: { "tasks": [...] }

Task format:
{
  "title": "short title",
  "prompt": "detailed instructions for the coding agent...",
  "agent_hint": "agent-name or runtime",
  "depends_on_indices": [0, 1],
  "priority": 8
}`;
}

function extractJson(text: string): string {
  // Try to extract JSON from markdown code blocks first
  const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (codeBlockMatch) {
    return codeBlockMatch[1].trim();
  }

  // Try to find a JSON object directly
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    return jsonMatch[0];
  }

  return text;
}

function validatePlan(plan: DecomposedPlan): Result<DecomposedPlan> {
  if (!plan.tasks || !Array.isArray(plan.tasks)) {
    return { ok: false, error: 'LLM response missing "tasks" array' };
  }

  if (plan.tasks.length < 1 || plan.tasks.length > 20) {
    return { ok: false, error: `Expected 2-8 tasks, got ${plan.tasks.length}` };
  }

  for (let i = 0; i < plan.tasks.length; i++) {
    const task = plan.tasks[i];
    if (!task.title || typeof task.title !== 'string') {
      return { ok: false, error: `Task at index ${i} missing title` };
    }
    if (!task.prompt || typeof task.prompt !== 'string') {
      return { ok: false, error: `Task at index ${i} missing prompt` };
    }

    if (task.depends_on_indices) {
      if (!Array.isArray(task.depends_on_indices)) {
        return { ok: false, error: `Task at index ${i} has invalid depends_on_indices` };
      }
      for (const dep of task.depends_on_indices) {
        if (typeof dep !== 'number' || dep < 0 || dep >= plan.tasks.length) {
          return { ok: false, error: `Task at index ${i} has out-of-range dependency index ${dep}` };
        }
        if (dep >= i) {
          return { ok: false, error: `Task at index ${i} depends on index ${dep} which is not before it` };
        }
      }
    }
  }

  return { ok: true, data: plan };
}

function matchAgentHint(hint: string | undefined, agents: Agent[]): string | null {
  if (!hint) return null;

  const lowerHint = hint.toLowerCase();

  // Match by exact name
  const byName = agents.find((a) => a.name.toLowerCase() === lowerHint);
  if (byName) return byName.id;

  // Match by runtime
  const byRuntime = agents.find((a) => a.runtime.toLowerCase() === lowerHint);
  if (byRuntime) return byRuntime.id;

  // Match by partial name
  const byPartial = agents.find((a) => a.name.toLowerCase().includes(lowerHint));
  if (byPartial) return byPartial.id;

  return null;
}

async function callLlmForDecomposition(goal: string): Promise<Result<DecomposedPlan>> {
  const agents = listAgents();
  const systemPrompt = buildSystemPrompt(agents);

  const llmResult = await completeText({
    systemPrompt,
    userMessage: goal,
    maxTokens: 4096,
  });

  if (!llmResult.ok) {
    return { ok: false, error: `LLM call failed: ${llmResult.error}` };
  }

  const rawJson = extractJson(llmResult.data);

  let parsed: DecomposedPlan;
  try {
    parsed = JSON.parse(rawJson) as DecomposedPlan;
  } catch (e) {
    logger.warn({ raw: llmResult.data.slice(0, 500) }, 'Failed to parse LLM response as JSON');
    return { ok: false, error: `Failed to parse LLM response: ${(e as Error).message}` };
  }

  return validatePlan(parsed);
}

/**
 * Preview a goal decomposition without creating tasks in the DB.
 * Useful for showing the user the plan before committing.
 */
export async function previewGoalPlan(goal: string): Promise<Result<DecomposedPlan>> {
  logger.info({ goal: goal.slice(0, 200) }, 'Previewing goal decomposition');
  return callLlmForDecomposition(goal);
}

/**
 * Decompose a goal into tasks, create them in the DB, set up dependencies,
 * and trigger dispatch.
 */
export async function decomposeGoal(goal: string): Promise<Result<GoalPlan>> {
  logger.info({ goal: goal.slice(0, 200) }, 'Decomposing goal into tasks');

  const planResult = await callLlmForDecomposition(goal);
  if (!planResult.ok) {
    return { ok: false, error: planResult.error };
  }

  const plan = planResult.data;
  const agents = listAgents();
  const createdTaskIds: string[] = [];
  const createdTasks: Task[] = [];

  // Create all tasks in the DB
  for (const goalTask of plan.tasks) {
    const agentId = matchAgentHint(goalTask.agent_hint, agents);

    const taskResult = insertTask({
      agent_id: agentId,
      prompt: goalTask.prompt,
      priority: goalTask.priority ?? 5,
    });

    if (!taskResult.ok) {
      logger.error({ error: taskResult.error, title: goalTask.title }, 'Failed to create task for goal');
      return { ok: false, error: `Failed to create task "${goalTask.title}": ${taskResult.error}` };
    }

    createdTaskIds.push(taskResult.data.id);
    createdTasks.push(taskResult.data);
  }

  // Set up dependencies using the index mapping
  for (let i = 0; i < plan.tasks.length; i++) {
    const goalTask = plan.tasks[i];
    if (goalTask.depends_on_indices && goalTask.depends_on_indices.length > 0) {
      for (const depIndex of goalTask.depends_on_indices) {
        const depTaskId = createdTaskIds[depIndex];
        const taskId = createdTaskIds[i];
        addDependency(taskId, depTaskId);
        logger.debug({ taskId, depTaskId, taskIndex: i, depIndex }, 'Added task dependency');
      }
    }
  }

  emit('goal.created', 'system', 'goal-orchestrator', {
    goal: goal.slice(0, 500),
    task_count: createdTaskIds.length,
    task_ids: createdTaskIds,
  });

  logger.info({ taskCount: createdTaskIds.length, taskIds: createdTaskIds }, 'Goal decomposed into tasks');

  // Trigger dispatch
  await dispatchNext({ manual: true });

  return {
    ok: true,
    data: {
      goal,
      tasks: plan.tasks,
      created_task_ids: createdTaskIds,
    },
  };
}
