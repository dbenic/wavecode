import type { Result } from './db.js';
import { completeText, isLlmConfigured } from './llm-provider.js';

export function isAvailable(): boolean {
  return isLlmConfigured();
}

export interface EnhanceRequest {
  prompt: string;
  runtime: string;
  agentName: string;
  lastOutput?: string;
  currentTask?: string;
}

export async function enhancePrompt(req: EnhanceRequest): Promise<Result<string>> {
  const systemPrompt = `You are a prompt engineering assistant for CLI coding agents. Your job is to take a user's draft prompt and enhance it to be more effective for the target CLI agent.

Rules:
- Return ONLY the enhanced prompt text, nothing else. No explanation, no markdown formatting.
- Keep the user's intent but make it more specific, actionable, and clear.
- Add relevant technical context when helpful.
- Structure multi-step tasks with clear numbered steps.
- For code tasks: mention file paths, function names, test expectations when you can infer them.
- Keep it concise — agents work better with focused prompts.
- Match the style to the target runtime.

Target runtime: ${req.runtime}
${req.runtime === 'claude-code' ? 'Style: Claude Code works well with detailed, structured prompts. Mention specific files and expected outcomes.' : ''}
${req.runtime === 'codex' ? 'Style: Codex CLI prefers concise, direct instructions. Be specific about what to change and where.' : ''}
${req.runtime === 'aider' ? 'Style: Aider works best with clear file references and specific change descriptions.' : ''}`;

  const contextParts: string[] = [];
  if (req.agentName) contextParts.push(`Agent: ${req.agentName}`);
  if (req.currentTask) contextParts.push(`Current task context: ${req.currentTask}`);
  if (req.lastOutput) {
    // Truncate to last 30 lines to save tokens
    const lastLines = req.lastOutput.split('\n').slice(-30).join('\n');
    contextParts.push(`Recent agent output (last 30 lines):\n${lastLines}`);
  }

  const userMessage = contextParts.length > 0
    ? `Context:\n${contextParts.join('\n\n')}\n\nDraft prompt to enhance:\n${req.prompt}`
    : `Draft prompt to enhance:\n${req.prompt}`;

  return completeText({
    systemPrompt,
    userMessage,
    maxTokens: 1024,
  });
}
