import { type Agent, type Run, getAgent, insertDecision } from './db.js';
import { isLlmConfigured, getResolvedLlmConfig } from './llm-provider.js';
import { emit } from './event-bus.js';
import logger from './logger.js';
import fs from 'node:fs';

const EXTRACTION_PROMPT = `You are analyzing a coding agent's transcript. Extract any architectural decisions the agent made — choices about technology, patterns, conventions, file organization, API design, etc.

Return a JSON array of decisions. Each decision should have:
- "summary": A one-line summary (max 100 chars). Start with a verb phrase like "Use...", "Prefer...", "Store...", etc.
- "detail": Optional one-sentence elaboration explaining the reasoning.

If no meaningful decisions were made, return an empty array: []

Only extract actual decisions, not routine coding actions. Good examples:
- "Use RS256 for JWT signing instead of HS256"
- "Store sessions in SQLite rather than Redis for simplicity"
- "Split API routes into per-resource files"

Bad examples (too granular / not decisions):
- "Created a new file"
- "Fixed a typo"
- "Added imports"

Return ONLY the JSON array, no surrounding text.`;

/**
 * After a successful run, extract architectural decisions from the transcript.
 * This is fire-and-forget — failures are logged but don't block the pipeline.
 *
 * @param run - The completed run
 * @param agent - The agent that ran it
 */
export async function extractDecisions(run: Run, agent: Agent): Promise<void> {
  if (!agent.workspace) return;
  if (!isLlmConfigured()) return;
  if (!run.transcript_path) return;

  try {
    // Read the last 2000 chars of the transcript
    let transcript: string;
    try {
      const full = fs.readFileSync(run.transcript_path, 'utf-8');
      transcript = full.slice(-2000);
    } catch {
      logger.debug({ runId: run.id }, 'No transcript file for decision extraction');
      return;
    }

    if (transcript.trim().length < 100) return; // Too short to contain decisions

    const llmConfig = getResolvedLlmConfig();

    // Use Anthropic SDK directly if anthropic provider
    if (llmConfig.provider === 'anthropic' && llmConfig.apiKey) {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      const client = new Anthropic({ apiKey: llmConfig.apiKey });

      const response = await client.messages.create({
        model: llmConfig.model ?? 'claude-haiku-4-20250414',
        max_tokens: 512,
        system: EXTRACTION_PROMPT,
        messages: [{ role: 'user', content: `Transcript (last portion):\n\n${transcript}` }],
      });

      const text = response.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('');

      parseAndStoreDecisions(text, agent, run);
    } else if (llmConfig.baseUrl) {
      // OpenAI-compatible endpoint
      const res = await fetch(`${llmConfig.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(llmConfig.apiKey ? { Authorization: `Bearer ${llmConfig.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: llmConfig.model,
          messages: [
            { role: 'system', content: EXTRACTION_PROMPT },
            { role: 'user', content: `Transcript (last portion):\n\n${transcript}` },
          ],
          max_tokens: 512,
          temperature: 0,
        }),
      });

      if (!res.ok) {
        logger.warn({ status: res.status }, 'Decision extraction LLM call failed');
        return;
      }

      const json = await res.json() as { choices: Array<{ message: { content: string } }> };
      const text = json.choices?.[0]?.message?.content ?? '';
      parseAndStoreDecisions(text, agent, run);
    }
  } catch (err) {
    logger.warn({ error: (err as Error).message, runId: run.id }, 'Decision extraction failed');
  }
}

function parseAndStoreDecisions(text: string, agent: Agent, run: Run): void {
  try {
    // Extract JSON array from response (handle markdown fences)
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return;

    const decisions = JSON.parse(jsonMatch[0]) as Array<{ summary: string; detail?: string }>;
    if (!Array.isArray(decisions) || decisions.length === 0) return;

    for (const d of decisions.slice(0, 5)) {
      if (!d.summary || typeof d.summary !== 'string') continue;
      const result = insertDecision({
        workspace: agent.workspace!,
        summary: d.summary.slice(0, 200),
        detail: d.detail?.slice(0, 500) ?? null,
        source_agent_id: agent.id,
        source_run_id: run.id,
      });
      if (result.ok) {
        emit('decision.created', 'decision', result.data.id, {
          workspace: agent.workspace,
          summary: result.data.summary,
          agent_name: agent.name,
        });
      }
    }

    logger.info(
      { runId: run.id, count: decisions.length, workspace: agent.workspace },
      'Extracted decisions from run transcript',
    );
  } catch {
    logger.debug({ runId: run.id }, 'Could not parse decisions from LLM response');
  }
}
