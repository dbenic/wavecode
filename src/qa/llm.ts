/**
 * Claude API wrapper for the QA agent. Defines the toolset the LLM is
 * allowed to use during a session and handles the request/response shape.
 *
 * Token budget: we deliberately drop old screenshots from the conversation
 * after each step (keeping only the latest) and replace them with a short
 * text summary of what happened. This keeps a 30-step session well under
 * 100K input tokens; without it we'd be sending 30+ images each turn.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { Persona, Scenario } from './types.js';

export const QA_TOOLS: Anthropic.Messages.Tool[] = [
  {
    name: 'click',
    description:
      'Click a visible element on the page. Prefer text or role-based selectors over CSS when possible — they are more robust.',
    input_schema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'CSS selector, visible text, or ARIA role name (depending on `by`)',
        },
        by: {
          type: 'string',
          enum: ['css', 'text', 'role'],
          description: 'How to interpret the selector',
        },
      },
      required: ['selector'],
    },
  },
  {
    name: 'type',
    description: 'Type a value into an input field.',
    input_schema: {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        value: { type: 'string' },
        by: {
          type: 'string',
          enum: ['css', 'placeholder', 'label'],
        },
      },
      required: ['selector', 'value'],
    },
  },
  {
    name: 'press_key',
    description: 'Press a single keyboard key (e.g. "Enter", "Escape", "Tab").',
    input_schema: {
      type: 'object',
      properties: { key: { type: 'string' } },
      required: ['key'],
    },
  },
  {
    name: 'navigate',
    description: 'Navigate the page to a URL.',
    input_schema: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
    },
  },
  {
    name: 'scroll',
    description: 'Scroll the page up or down by an amount in pixels.',
    input_schema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['up', 'down'] },
        amount: { type: 'integer' },
      },
      required: ['direction'],
    },
  },
  {
    name: 'wait',
    description: 'Wait a few seconds for the page to settle.',
    input_schema: {
      type: 'object',
      properties: { seconds: { type: 'number' } },
      required: ['seconds'],
    },
  },
  {
    name: 'record_finding',
    description:
      'Record an observation: a bug (broken behaviour), a UX issue (works but bad), a design question (intent unclear), or a suggestion. Cite specific on-screen text as evidence — never report a finding without evidence.',
    input_schema: {
      type: 'object',
      properties: {
        severity: {
          type: 'string',
          enum: ['bug', 'ux_issue', 'question', 'suggestion'],
        },
        summary: { type: 'string', description: 'One-line headline' },
        evidence: {
          type: 'string',
          description: 'Quote the exact on-screen text or describe what you saw',
        },
        why_it_matters: {
          type: 'string',
          description: 'Why this matters for a user; cite the persona if relevant',
        },
        suggested_fix: { type: 'string' },
      },
      required: ['severity', 'summary', 'evidence', 'why_it_matters'],
    },
  },
  {
    name: 'complete',
    description:
      'Finish the session. Use when you have either accomplished the goal, been blocked, or decided to abandon as the persona would.',
    input_schema: {
      type: 'object',
      properties: {
        outcome: { type: 'string', enum: ['completed', 'abandoned', 'blocked'] },
        notes: { type: 'string' },
      },
      required: ['outcome'],
    },
  },
];

export function buildSystemPrompt(persona: Persona, scenario: Scenario): string {
  return `You are a Wavenetic QA agent inhabiting a specific user persona.

## Persona: ${persona.name}
${persona.description}

${persona.prompt}

## Your task
${scenario.goal}

Starting URL: ${scenario.starting_url}
${scenario.acceptance_criteria ? `\nAcceptance criteria:\n${scenario.acceptance_criteria.map((c) => `- ${c}`).join('\n')}` : ''}

## How to behave

1. Try to accomplish the task as the persona would. Pace yourself, get confused where they would, abandon where they would.
2. For each screenshot, describe briefly what you see, then decide your next action.
3. Capture **every moment of friction**: confusing labels, missing feedback, slow responses, bad empty states, surprising behaviours.
4. Distinguish:
   - **bug** — broken behaviour (error, crash, wrong result)
   - **ux_issue** — works but bad (confusing, slow, ugly, unclear)
   - **question** — intent unclear, you'd ask the designer "why?"
   - **suggestion** — improvement idea, not a defect
5. Every finding must cite **specific on-screen text or describable visual evidence**. No vague claims.
6. When you have accomplished the goal — or as the persona would give up — call \`complete\`.

## Tool usage

- Prefer \`by: text\` or \`by: role\` for clicks (more robust than CSS)
- Prefer \`by: label\` or \`by: placeholder\` for typing
- Don't loop forever: 25 steps maximum, but call \`complete\` earlier when you're done
- After actions that may load data, \`wait\` 1-2 seconds before re-screenshotting
- Use \`record_finding\` immediately when you observe something — don't batch

Be specific. Don't say "could be improved" — say "the button label is 'Continue' but I don't know what it continues to". Quote the actual on-screen text. Cite the persona's expectations.`;
}

export interface LlmCallParams {
  apiKey: string;
  model: string;
  system: string;
  messages: Anthropic.Messages.MessageParam[];
  maxTokens?: number;
}

export async function callLlm(params: LlmCallParams): Promise<Anthropic.Messages.Message> {
  const client = new Anthropic({ apiKey: params.apiKey });
  return client.messages.create({
    model: params.model,
    max_tokens: params.maxTokens ?? 2048,
    system: [
      {
        type: 'text',
        text: params.system,
        cache_control: { type: 'ephemeral' },
      },
    ],
    tools: QA_TOOLS,
    messages: params.messages,
  });
}

/**
 * Cost estimation per call. Pricing as of writing (Sonnet 4.5):
 *   input  $3 / 1M     cached  $0.30 / 1M     output  $15 / 1M
 * Image tokens approximated at 1500 per 1024x800 screenshot.
 */
export function estimateCost(usage: Anthropic.Messages.Usage | undefined): number {
  if (!usage) return 0;
  const input = (usage.input_tokens ?? 0) * 3e-6;
  const cached = (usage.cache_read_input_tokens ?? 0) * 0.3e-6;
  const output = (usage.output_tokens ?? 0) * 15e-6;
  return input + cached + output;
}
