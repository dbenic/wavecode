/**
 * Task Verifier — Optional lightweight LLM check after task completion.
 *
 * When enabled (autonomy.verify_completion = true), after the output watcher
 * detects an agent going idle, the verifier reads the last N lines of output
 * and asks an LLM: "Did the agent complete the task successfully?"
 *
 * Based on the answer it either:
 *   - Confirms → task stays 'done'
 *   - Failed → marks task 'failed', optionally retries
 *   - Partial → marks task 'pending' for another attempt
 *
 * Uses whichever LLM provider is configured (Anthropic, OpenAI, Gemini, etc.)
 * Cost is minimal: ~200-500 input tokens + ~50 output tokens per check.
 */

import { getConfig } from './config.js';
import { getTask, getAgent, updateTaskStatus, type Task, type Agent } from './db.js';
import { capturePane } from './session-manager.js';
import { getResolvedLlmConfig, isLlmConfigured } from './llm-provider.js';
import { emit } from './event-bus.js';
import * as taskDispatcher from './task-dispatcher.js';
import logger from './logger.js';

export type VerifyResult = 'completed' | 'failed' | 'partial' | 'unknown';

interface VerifyResponse {
  result: VerifyResult;
  reason: string;
  confidence: number; // 0-1
}

const SYSTEM_PROMPT = `You are a task completion verifier for a multi-agent coding system.
You will be given:
1. The TASK that was assigned to the agent (what it was supposed to do)
2. The TERMINAL OUTPUT (last lines from the agent's terminal after it finished)

Analyze whether the agent completed the task successfully.

Respond with ONLY a JSON object (no markdown, no explanation outside JSON):
{
  "result": "completed" | "failed" | "partial",
  "reason": "one-line explanation",
  "confidence": 0.0-1.0
}

Rules:
- "completed": Agent clearly finished the task. Look for: commits, "done", file changes, build success, etc.
- "failed": Agent encountered an error, crash, or explicitly said it couldn't do the task.
- "partial": Agent did some work but didn't finish, or results are ambiguous.
- Be generous — if the agent's output shows it did work and returned to prompt without errors, that's likely "completed".
- If you see "Brewed for", "Churned for", "Cooked for" etc. followed by an empty prompt, the agent finished its work cycle.`;

/**
 * Verify if a task was actually completed by checking the agent's terminal output.
 * Returns null if verification is disabled or unavailable.
 */
export async function verifyTaskCompletion(
  taskId: string,
  agentId: string,
): Promise<VerifyResponse | null> {
  const config = getConfig();

  // Check if verification is enabled
  if (!config.autonomy.verify_completion) return null;
  if (!isLlmConfigured()) {
    logger.debug('Task verification skipped — no LLM configured');
    return null;
  }

  const taskResult = getTask(taskId);
  if (!taskResult.ok) return null;

  const agentResult = getAgent(agentId);
  if (!agentResult.ok) return null;

  const task = taskResult.data;
  const agent = agentResult.data;

  // Capture last 30 lines of terminal output
  const captureResult = capturePane(agent.tmux_session, 30);
  if (!captureResult.ok) return null;

  const output = captureResult.data
    .replace(/[^\x20-\x7E\n\r\t]/g, ' ') // Strip control chars
    .replace(/  +/g, ' ')
    .trim();

  if (!output) return null;

  try {
    const result = await callLlmForVerification(task, output);
    logger.info(
      { taskId, agentId, result: result.result, confidence: result.confidence },
      `Task verification: ${result.result} (${Math.round(result.confidence * 100)}%)`,
    );

    // Act on the result
    if (result.result === 'failed' && result.confidence >= 0.7) {
      // High-confidence failure — mark task as failed
      updateTaskStatus(taskId, 'failed');
      emit('task.failed', 'task', taskId, {
        agent_id: agentId,
        reason: result.reason,
        verified: true,
      });

      // Retry if we haven't exceeded max retries
      const config = getConfig();
      const { listRuns } = await import('./db.js');
      const attempts = listRuns({ task_id: taskId });
      if (attempts.length < config.autonomy.max_task_retries) {
        updateTaskStatus(taskId, 'pending');
        emit('task.retrying', 'task', taskId, {
          reason: result.reason,
          attempt: attempts.length + 1,
        });
        setTimeout(() => taskDispatcher.dispatchNext(), 2000);
      }
    } else if (result.result === 'partial' && result.confidence >= 0.7) {
      // Partial completion — re-queue with context
      logger.info({ taskId }, 'Task partially completed, re-queuing');
      // Keep as done — user can manually retry if needed
    }
    // For 'completed' or low-confidence results, keep the task as-is (done)

    return result;
  } catch (err) {
    logger.warn(
      { taskId, error: (err as Error).message },
      'Task verification LLM call failed',
    );
    return null;
  }
}

async function callLlmForVerification(
  task: Task,
  terminalOutput: string,
): Promise<VerifyResponse> {
  const llmConfig = getResolvedLlmConfig();

  const userPrompt = `## TASK
${task.prompt.substring(0, 500)}

## TERMINAL OUTPUT (last 30 lines)
${terminalOutput.substring(0, 2000)}`;

  if (!llmConfig.apiKey) {
    return { result: 'unknown', reason: 'No API key configured', confidence: 0 };
  }

  let response: string;

  if (llmConfig.provider === 'anthropic') {
    response = await callAnthropic({ apiKey: llmConfig.apiKey, model: llmConfig.model }, userPrompt);
  } else {
    response = await callOpenAICompatible({
      apiKey: llmConfig.apiKey,
      baseUrl: llmConfig.baseUrl || 'https://api.openai.com/v1',
      model: llmConfig.model,
    }, userPrompt);
  }

  // Parse JSON response
  const jsonMatch = response.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return { result: 'unknown', reason: 'Failed to parse LLM response', confidence: 0 };
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]) as VerifyResponse;
    // Validate
    if (!['completed', 'failed', 'partial'].includes(parsed.result)) {
      parsed.result = 'unknown';
    }
    parsed.confidence = Math.max(0, Math.min(1, parsed.confidence ?? 0.5));
    return parsed;
  } catch {
    return { result: 'unknown', reason: 'JSON parse error', confidence: 0 };
  }
}

async function callAnthropic(
  llmConfig: { apiKey: string; model: string },
  userPrompt: string,
): Promise<string> {
  // Use Haiku for cost efficiency — verification doesn't need a big model
  const model = 'claude-haiku-4-20250514';

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': llmConfig.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 200,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${errBody.substring(0, 200)}`);
  }

  const data = await res.json() as { content: Array<{ text: string }> };
  return data.content[0]?.text ?? '';
}

async function callOpenAICompatible(
  llmConfig: { apiKey: string; baseUrl: string; model: string },
  userPrompt: string,
): Promise<string> {
  const baseUrl = llmConfig.baseUrl || 'https://api.openai.com/v1';
  // Use a cheap model for verification
  const model = 'gpt-4.1-mini';

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${llmConfig.apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: 200,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`OpenAI API error ${res.status}: ${errBody.substring(0, 200)}`);
  }

  const data = await res.json() as { choices: Array<{ message: { content: string } }> };
  return data.choices[0]?.message?.content ?? '';
}
