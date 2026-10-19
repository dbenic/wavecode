/**
 * Change an agent's model from the UI and have it take effect.
 *
 * A pin (model, effort) is stored on the agent and injected at launch. That
 * alone changed nothing for a TUI that was already running, so people typed
 * `/model` into the pane and picked from a menu they could not see.
 *
 * Now: the catalogue comes from the CLI itself (Codex's models_cache.json in
 * the agent's profile; a configured list for Claude Code), and applying a
 * pin does the right thing per runtime. Claude Code accepts `/model <id>`
 * live. Codex is asked to quit and is relaunched with `-m` and the effort,
 * resuming its conversation. An agent that is working gets the change when
 * it next goes idle. A dead runtime gets it on relaunch.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getConfig } from './config.js';
import { EFFORT_LEVELS, getAgent, updateAgentPin, type Agent, type EffortLevel, type Result } from './db.js';
import { emit, onEvent } from './event-bus.js';
import logger from './logger.js';
import { resolveProfileEnv } from './profiles.js';
import { ensureRuntimeAlive, getRuntimeState, noteRuntimeAlive, relaunchRuntime, waitForRuntimeSettled } from './runtime-liveness.js';
import * as tmux from './tmux.js';

export interface ModelChoice {
  id: string;
  label: string;
  efforts: EffortLevel[];
}

export interface ModelCatalogue {
  runtime: string;
  models: ModelChoice[];
  /** The runtime has no known list: the UI offers a free text box. */
  free_text: boolean;
  /** Where the list came from, for the panel's footnote. */
  source: 'codex_cache' | 'config' | 'builtin' | 'none';
}

const CLAUDE_BUILTIN = ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
const MODEL_ID = /^[a-zA-Z0-9][a-zA-Z0-9._/:-]{0,99}$/;

function effortsFrom(raw: unknown): EffortLevel[] {
  if (!Array.isArray(raw)) return [];
  const out: EffortLevel[] = [];
  for (const item of raw) {
    const word = typeof item === 'string' ? item : (item as { effort?: unknown })?.effort;
    if (typeof word === 'string' && (EFFORT_LEVELS as readonly string[]).includes(word)) out.push(word as EffortLevel);
  }
  return out;
}

/** Codex writes the models it may use to `$CODEX_HOME/models_cache.json`. Exported for tests. */
export function parseCodexModelsCache(text: string): ModelChoice[] {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return []; }
  const items = Array.isArray(parsed) ? parsed : ((parsed as { models?: unknown; data?: unknown })?.models ?? (parsed as { data?: unknown })?.data);
  if (!Array.isArray(items)) return [];
  const out: ModelChoice[] = [];
  for (const m of items) {
    if (!m || typeof m !== 'object') continue;
    const row = m as Record<string, unknown>;
    const id = typeof row.slug === 'string' ? row.slug : typeof row.id === 'string' ? row.id : null;
    if (!id || !MODEL_ID.test(id)) continue;
    const label = typeof row.display_name === 'string' ? row.display_name : typeof row.label === 'string' ? row.label : id;
    out.push({ id, label, efforts: effortsFrom(row.supported_reasoning_levels ?? row.reasoning_levels) });
  }
  return out;
}

function codexHome(agent: Pick<Agent, 'runtime' | 'profile'>): string {
  const env = resolveProfileEnv(agent.runtime, agent.profile ?? null);
  const fromProfile = env.ok ? env.data.CODEX_HOME : undefined;
  return fromProfile ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
}

/** The models this agent's CLI can use, with the efforts each accepts. */
export function listModels(agent: Pick<Agent, 'runtime' | 'profile'>): ModelCatalogue {
  const rc = getConfig().runtimes[agent.runtime];
  const configured = rc?.models;
  if (Array.isArray(configured) && configured.length > 0) {
    const efforts = rc?.effort_flag ? [...EFFORT_LEVELS] : [];
    return { runtime: agent.runtime, free_text: false, source: 'config', models: configured.filter((m) => MODEL_ID.test(m)).map((id) => ({ id, label: id, efforts })) };
  }
  if (agent.runtime === 'codex') {
    try {
      const text = fs.readFileSync(path.join(codexHome(agent), 'models_cache.json'), 'utf8');
      const models = parseCodexModelsCache(text);
      if (models.length > 0) return { runtime: agent.runtime, free_text: false, source: 'codex_cache', models };
    } catch { /* no cache yet: the CLI has not run on this profile */ }
    return { runtime: agent.runtime, free_text: true, source: 'none', models: [] };
  }
  if (agent.runtime === 'claude-code') {
    const efforts = rc?.effort_flag ? (['low', 'medium', 'high'] as EffortLevel[]) : [];
    return { runtime: agent.runtime, free_text: false, source: 'builtin', models: CLAUDE_BUILTIN.map((id) => ({ id, label: id, efforts })) };
  }
  return { runtime: agent.runtime, free_text: true, source: 'none', models: [] };
}

export type Applied = 'live' | 'relaunched' | 'when_idle' | 'on_relaunch' | 'pin_only';

export interface SwitchResult {
  agent: Agent;
  applied: Applied;
  note: string;
}

const pending = new Map<string, { model: string | null | undefined; effort: EffortLevel | null | undefined }>();
let subscribed: (() => void) | null = null;

export function resetModelSwitchForTest(): void {
  pending.clear();
  if (subscribed) { subscribed(); subscribed = null; }
}

const QUIT_WAIT_MS = 15_000;
const QUIT_POLL_MS = 500;

async function waitForDead(agent: Agent, timeoutMs = QUIT_WAIT_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, QUIT_POLL_MS));
    if (await getRuntimeState(agent) === 'dead') return true;
  }
  return false;
}

/**
 * Make the stored pin the running model. Exported for tests.
 * Claude Code: `/model <id>` in the pane. Codex: `/quit`, then relaunch with
 * the pin (resuming the conversation). Anything else: the pin waits for the
 * next relaunch.
 */
export async function applyPin(agent: Agent): Promise<{ applied: Applied; note: string }> {
  const state = await getRuntimeState(agent);
  if (state === 'dead') {
    const up = await ensureRuntimeAlive(agent);
    return up.ok
      ? { applied: 'relaunched', note: 'The runtime was down; relaunched with the new model.' }
      : { applied: 'on_relaunch', note: `The runtime is down and could not be relaunched (${up.error}); the pin applies when it comes back.` };
  }
  if (agent.runtime === 'claude-code') {
    if (!agent.model) return { applied: 'on_relaunch', note: 'Pin cleared; the CLI default applies on the next relaunch.' };
    tmux.sendTextAndEnter(agent.tmux_session, `/model ${agent.model}`);
    return { applied: 'live', note: `Sent /model ${agent.model} to the running CLI.` };
  }
  if (agent.runtime === 'codex') {
    tmux.sendTextAndEnter(agent.tmux_session, '/quit');
    let dead = await waitForDead(agent);
    if (!dead) {
      try { tmux.sendRawKey(agent.tmux_session, 'C-c'); tmux.sendRawKey(agent.tmux_session, 'C-c'); } catch { /* best effort */ }
      dead = await waitForDead(agent, 5_000);
    }
    if (!dead) return { applied: 'on_relaunch', note: 'Codex did not quit; the pin applies on the next relaunch.' };
    const relaunch = await relaunchRuntime(agent, 'manual');
    if (!relaunch.ok) return { applied: 'on_relaunch', note: `Codex quit but the relaunch failed (${relaunch.error}).` };
    const settled = await waitForRuntimeSettled(agent);
    if (settled) noteRuntimeAlive(agent.id);
    return settled
      ? { applied: 'relaunched', note: 'Codex restarted with the new model and resumed its conversation.' }
      : { applied: 'on_relaunch', note: 'Codex was relaunched but has not settled yet.' };
  }
  return { applied: 'on_relaunch', note: 'This runtime takes the pin on its next relaunch.' };
}

function subscribeIdle(): void {
  if (subscribed) return;
  subscribed = onEvent((e) => {
    const agentId = e.entity_id;
    if (e.type !== 'agent.status_changed' || !pending.has(agentId)) return;
    let status: string | undefined;
    try { status = (JSON.parse(e.payload_json ?? 'null') as { status?: string } | null)?.status; } catch { status = undefined; }
    if (status !== 'idle') return;
    pending.delete(agentId);
    const agent = getAgent(agentId);
    if (!agent.ok) return;
    void applyPin(agent.data).then((r) => {
      emit('agent.model_applied', 'agent', agent.data.id, { name: agent.data.name, model: agent.data.model, effort: agent.data.effort, applied: r.applied, note: r.note });
    }).catch((err) => logger.warn({ agentId, error: (err as Error).message }, 'Deferred model switch failed'));
  });
}

/** Store the pin and apply it now, or when the agent is next idle. */
export async function switchModel(agent: Agent, pin: { model?: string | null; effort?: EffortLevel | null }): Promise<Result<SwitchResult>> {
  if (pin.model != null && !MODEL_ID.test(pin.model)) return { ok: false, error: 'model must be an id like gpt-6-astra or claude-fable-5-1' };
  if (pin.effort != null && !(EFFORT_LEVELS as readonly string[]).includes(pin.effort)) return { ok: false, error: `effort must be one of ${EFFORT_LEVELS.join(', ')}` };
  const stored = updateAgentPin(agent.id, { model: pin.model, effort: pin.effort });
  if (!stored.ok) return { ok: false, error: stored.error };
  const updated = stored.data;
  emit('agent.updated', 'agent', updated.id, { name: updated.name, model: updated.model, effort: updated.effort });

  if (updated.status === 'working') {
    subscribeIdle();
    pending.set(updated.id, { model: pin.model, effort: pin.effort });
    return { ok: true, data: { agent: updated, applied: 'when_idle', note: 'Saved. The agent is working; the new model applies as soon as it is idle.' } };
  }
  try {
    const r = await applyPin(updated);
    emit('agent.model_applied', 'agent', updated.id, { name: updated.name, model: updated.model, effort: updated.effort, applied: r.applied, note: r.note });
    return { ok: true, data: { agent: updated, ...r } };
  } catch (e) {
    return { ok: true, data: { agent: updated, applied: 'pin_only', note: `Saved, but applying it failed: ${(e as Error).message}` } };
  }
}
