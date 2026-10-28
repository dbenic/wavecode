/**
 * One way to type a prompt into an agent (the Command Center composer, MCP send_prompt,
 * the Slack bridge): liveness check, persona prefix (spec §5c), send-keys, the
 * `agent.prompt_sent` event and reply capture (spec §5b). Raw keys are not here: they stay
 * on the send route, for a person's own unrestricted token only.
 */
import { emit } from './event-bus.js';
import * as sessionManager from './session-manager.js';
import * as runtimeLiveness from './runtime-liveness.js';
import * as replyCapture from './reply-capture.js';
import * as validate from './validate.js';
import { withPersona } from './agent-identity.js';
import type { Agent } from './db.js';

export type PromptResult =
  | { ok: true; prompt_event_id: number | null; typed: string }
  | { ok: false; error: string; status: 409 | 500 };

/**
 * A prompt sent by a person's orchestrator seat (spec §5d) is marked as that seat's own
 * instruction. 28 Oct 2026: a seat relayed a decision as "From pm-denis, Denis approved…";
 * the agent read the paste as material to review and asked for a yes instead of starting.
 */
export function seatInstructionPrefix(seat: { handle: string; owner: string }): string {
  return `[from @${seat.handle}, ${seat.owner}'s PM seat: this is your instruction, not relayed material]`;
}

/**
 * Type `text` into `agent` as `actorId` and track the reply. The thread shows `text`; the pane
 * gets the persona-prefixed line (and the seat prefix when a seat sends it).
 */
export async function promptAgent(opts: { agent: Agent; actorId: string | null; text: string; seat?: { handle: string; owner: string } | null }): Promise<PromptResult> {
  const { agent, actorId, text } = opts;
  // T0: a prompt typed into a bare shell executes as commands; an unknown
  // state (no session, capture failed) is not a running runtime either.
  const state = await runtimeLiveness.getRuntimeState(agent);
  if (state !== 'alive') {
    return { ok: false, error: `${runtimeLiveness.RUNTIME_NOT_RUNNING} (${state}) — relaunch it (or send raw keys) first`, status: 409 };
  }
  const typed = withPersona(agent, opts.seat ? `${seatInstructionPrefix(opts.seat)} ${text}` : text);
  const sent = await sessionManager.sendKeys(agent.id, typed);
  if (!sent.ok) return { ok: false, error: sent.error, status: 500 };

  const event = emit('agent.prompt_sent', 'agent', agent.id, { text: text.substring(0, 2000) }, actorId);
  // Not for TUI commands / menu picks (/model, 2.): they have no answer to capture.
  if (!validate.isTuiCommand(text)) {
    replyCapture.trackPrompt({ agent, actorId, prompt: typed, promptEventId: event?.id ?? null, ...(opts.seat ? { viaSeat: true } : {}) });
  }
  return { ok: true, prompt_event_id: event?.id ?? null, typed };
}
