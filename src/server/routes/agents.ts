import type { Hono } from 'hono';
import {
  listAgents,
  getAgent,
  updateAgentPin,
  updateAgentRole,
  updateAgentIdentity,
  updateAgentSocket,
  addAgentTag,
  removeAgentTag,
  listAllAgentTags,
  type Agent,
  type AgentRole,
  type EffortLevel,
} from '../db.js';
import { emit } from '../event-bus.js';
import * as sessionManager from '../session-manager.js';
import * as outputWatcher from '../output-watcher.js';
import * as validate from '../validate.js';
import logger from '../logger.js';
import { getActingUser, type NodeAppEnv } from '../auth.js';
import { getConfig } from '../config.js';
import { isAdmin } from '../users.js';
import type { User } from '../db.js';
import * as leases from '../leases.js';
import * as modelSwitch from '../model-switch.js';
import * as runtimeLiveness from '../runtime-liveness.js';
import * as replyCapture from '../reply-capture.js';
import { briefOrchestratorSeat, parseAgentRole } from '../orchestrator.js';
import { defaultSeatFor } from '../seats.js';
import { validateAlias, validatePersona, validateTag, withPersona } from '../agent-identity.js';
import { isProfileCompatible, requireProfileLogin, resolveSpawnProfile } from '../profiles.js';
import { agentAllowedFor, isRestrictedUser } from '../users.js';
import { runtimeDefaultsFor, subscriptionFor } from '../subscription-info.js';
import { usageFor } from '../usage-probe.js';
import { bindSessionSocket } from '../tmux.js';

export function registerAgentRoutes(app: Hono<NodeAppEnv>): void {
  app.get('/api/agents', (c) => {
    const viewer = getActingUser(c);
    // A restricted token (docs/peers.md) sees only its named agents
    const agents = listAgents().filter((a) => agentAllowedFor(viewer, a));
    // Spec §5d: the default (Ask) target is the viewer's own seat, else the shared one
    const orchestratorId = defaultSeatFor(getActingUser(c), agents)?.id ?? null;
    const tags = safeAllTags();
    return c.json(agents.map((a) => enrichAgent(a, getActingUser(c), orchestratorId, tags?.get(a.id) ?? [])));
  });

  app.get('/api/agents/:id', (c) => {
    const result = sessionManager.get(c.req.param('id'));
    if (!result.ok) return c.json({ error: result.error }, 404);
    if (!agentAllowedFor(getActingUser(c), result.data)) return c.json({ error: 'Forbidden: not one of this token\'s agents' }, 403);
    return c.json(enrichAgent(result.data, getActingUser(c)));
  });

  app.post('/api/agents/scan', async (c) => {
    const body = await c.req.json<{ socket?: unknown }>().catch(() => ({} as { socket?: unknown }));
    const socket = typeof body.socket === 'string' && body.socket.trim() ? body.socket.trim() : null;
    const result = await sessionManager.scan(socket);
    if (!result.ok) return c.json({ error: result.error }, 500);

    const adoptedSessions = new Set(listAgents().map((a) => a.tmux_session));
    return c.json(result.data.map((session) => ({
      ...session,
      adopted: adoptedSessions.has(session.name),
    })));
  });

  app.post('/api/agents/adopt', async (c) => {
    const body = await c.req.json<{
      sessionName: string;
      runtime: Agent['runtime'];
      name?: string;
      /** 'orchestrator' = the PM seat; it is sent docs/orchestrator-seat.md (spec §5b). */
      role?: string | null;
      tmux_socket?: string | null;
    }>();

    const validationError = validate.validateAdoptBody(body);
    if (validationError) return c.json({ error: validationError }, 400);
    const role = parseAgentRole(body.role);
    if (!role.ok) return c.json({ error: role.error }, 400);

    const result = await sessionManager.adopt(body.sessionName, body.runtime, body.name, body.tmux_socket ?? null);
    if (!result.ok) return c.json({ error: result.error }, 400);

    const agent = result.data;
    outputWatcher.startWatching(agent.id);

    emit('agent.adopted', 'agent', agent.id, {
      name: agent.name,
      runtime: agent.runtime,
      tmuxSession: agent.tmux_session,
    });

    logger.info({ agentId: agent.id, session: agent.tmux_session }, 'Agent adopted');
    if (role.role) return c.json(assignRole(agent, role.role, getActingUser(c).id), 201);
    return c.json(agent, 201);
  });

  app.post('/api/agents/:id/send', async (c) => {
    const body = await c.req.json<{ text: string; raw?: boolean }>();
    const validationError = validate.validateSendBody(body);
    if (validationError) return c.json({ error: validationError }, 400);

    const agentResult = sessionManager.get(c.req.param('id'));
    if (!agentResult.ok) return c.json({ error: agentResult.error }, 404);
    const access = leases.checkAgentAccess(agentResult.data, getActingUser(c));
    if (!access.ok) return c.json({ error: access.error }, 403);

    let typed = body.text;
    const user = getActingUser(c);
    if (body.raw) {
      // Raw keys (C-c, Escape, Enter) fix a stuck shell — a person's own, unrestricted
      // token only. A peer's ask-only token or a seat must never interrupt an agent.
      if (isRestrictedUser(user) || user.via_seat) {
        return c.json({ error: 'Forbidden: raw keys need a person\'s own unrestricted token' }, 403);
      }
      const result = await sessionManager.sendRawKeys(agentResult.data.id, body.text);
      if (!result.ok) return c.json({ error: result.error }, 500);
    } else {
      // T0: a prompt typed into a bare shell executes as commands; an unknown
      // state (no session, capture failed) is not a running runtime either.
      const state = await runtimeLiveness.getRuntimeState(agentResult.data);
      if (state !== 'alive') {
        return c.json({ error: `${runtimeLiveness.RUNTIME_NOT_RUNNING} (${state}) — relaunch it (or send raw keys) first` }, 409);
      }
      // Spec §5c: `[you are @toni — frontend lead] …` when the agent has a persona
      typed = withPersona(agentResult.data, body.text);
      const result = await sessionManager.sendKeys(agentResult.data.id, typed);
      if (!result.ok) return c.json({ error: result.error }, 500);
    }

    // The thread shows what the person wrote; the pane got the persona-prefixed text.
    const sent = emit('agent.prompt_sent', 'agent', agentResult.data.id, {
      text: body.text.substring(0, 2000),
    });

    // Spec §5b: the agent's answer to this prompt is captured into the thread.
    // Not for TUI commands / menu picks (/model, 2.): they have no answer to capture.
    if (!body.raw && !validate.isTuiCommand(body.text)) {
      replyCapture.trackPrompt({
        agent: agentResult.data,
        actorId: getActingUser(c).id,
        prompt: typed,
        promptEventId: sent?.id ?? null,
      });
    }

    // prompt_event_id lets a caller (a peer WaveCode, an MCP seat) match the captured reply to this prompt
    return c.json({ ok: true, prompt_event_id: sent?.id ?? null });
  });

  app.get('/api/agents/:id/output', async (c) => {
    const agentResult = sessionManager.get(c.req.param('id'));
    if (!agentResult.ok) return c.json({ error: agentResult.error }, 404);
    if (!agentAllowedFor(getActingUser(c), agentResult.data)) return c.json({ error: 'Forbidden: not one of this token\'s agents' }, 403);

    const lines = validate.validateIntParam(c.req.query('lines'), { min: 1, max: 500, default: 50 });
    const useAnsi = c.req.query('ansi') === 'true';

    if (useAnsi) {
      const result = await sessionManager.capturePaneAnsi(agentResult.data.tmux_session, lines);
      if (!result.ok) return c.json({ error: result.error }, 500);

      const cleaned = cleanCapturedOutput(result.data);
      return c.json({
        output: cleaned,
        html: await renderAnsiHtml(cleaned),
      });
    }

    const result = await sessionManager.capturePane(agentResult.data.tmux_session, lines);
    if (!result.ok) return c.json({ error: result.error }, 500);

    return c.json({ output: cleanCapturedOutput(result.data) });
  });

  app.get('/api/agents/:id/scrollback', async (c) => {
    const agentResult = sessionManager.get(c.req.param('id'));
    if (!agentResult.ok) return c.json({ error: agentResult.error }, 404);

    const session = agentResult.data.tmux_session;
    const start = validate.validateIntParam(c.req.query('start'), { min: -10000, max: 0, default: -200 });
    const end = validate.validateIntParam(c.req.query('end'), { min: -10000, max: 0, default: -100 });
    const sizeResult = await sessionManager.getScrollbackSize(session);
    const totalLines = sizeResult.ok ? sizeResult.data : 0;

    const result = await sessionManager.capturePaneRange(session, start, end);
    if (!result.ok) return c.json({ error: result.error }, 500);

    const cleaned = cleanCapturedOutput(result.data);
    return c.json({
      html: await renderAnsiHtml(cleaned),
      output: cleaned,
      totalLines,
      start,
      end,
      hasMore: Math.abs(start) < totalLines,
    });
  });

  app.delete('/api/agents/:id', (c) => {
    const agentId = c.req.param('id');
    const agentResult = getAgent(agentId);
    if (!agentResult.ok) return c.json({ error: agentResult.error }, 404);
    const access = leases.checkAgentAccess(agentResult.data, getActingUser(c));
    if (!access.ok) return c.json({ error: access.error }, 403);

    outputWatcher.stopWatching(agentId);
    sessionManager.detach(agentId);

    emit('agent.detached', 'agent', agentId, { name: agentResult.data.name });
    logger.info({ agentId }, 'Agent detached');

    return c.json({ ok: true });
  });

  app.post('/api/agents/:id/kill', async (c) => {
    const agentResult = sessionManager.get(c.req.param('id'));
    if (!agentResult.ok) return c.json({ error: agentResult.error }, 404);

    const agent = agentResult.data;
    const access = leases.checkAgentAccess(agent, getActingUser(c));
    if (!access.ok) return c.json({ error: access.error }, 403);
    outputWatcher.stopWatching(agent.id);

    const result = await sessionManager.kill(agent.id);
    if (!result.ok) return c.json({ error: result.error }, 400);

    emit('agent.killed', 'agent', agent.id, {
      name: agent.name,
      tmuxSession: agent.tmux_session,
    });

    logger.info({ agentId: agent.id, session: agent.tmux_session }, 'Agent killed');
    return c.json({ ok: true });
  });

  /**
   * Restart (thread `alert` action): a spawned agent whose session died gets
   * a fresh session; a live session whose runtime TUI exited gets the
   * runtime relaunched in place (T0). Adopted agents with a dead session
   * cannot be restarted — WaveCode never owned their launch command.
   */
  app.post('/api/agents/:id/restart', async (c) => {
    const agentResult = sessionManager.get(c.req.param('id'));
    if (!agentResult.ok) return c.json({ error: agentResult.error }, 404);
    const agent = agentResult.data;
    const access = leases.checkAgentAccess(agent, getActingUser(c));
    if (!access.ok) return c.json({ error: access.error }, 403);

    if (agent.mode === 'spawned') {
      const ensured = await sessionManager.ensureSpawnedAgentSession(agent.id);
      if (!ensured.ok) return c.json({ error: ensured.error }, 400);
      if (ensured.data.createdSession) {
        outputWatcher.startWatching(agent.id);
        emit('agent.restarted', 'agent', agent.id, { name: agent.name });
        return c.json({ ok: true, action: 'session_recreated' });
      }
    }

    const state = await runtimeLiveness.getRuntimeState(agent);
    if (state === 'dead') {
      const relaunched = await runtimeLiveness.relaunchRuntime(agent, 'manual');
      if (!relaunched.ok) return c.json({ error: relaunched.error }, 400);
      return c.json({ ok: true, action: relaunched.data.sent ? 'runtime_relaunched' : 'relaunch_in_progress' });
    }
    if (state === 'unknown') {
      return c.json({ error: `Session '${agent.tmux_session}' is not running and cannot be restarted` }, 400);
    }
    return c.json({ ok: true, action: 'already_running' });
  });

  // --- Tag groups (spec §5c): `#tag @x frontend`, `@frontend text` fans out ---
  app.post('/api/agents/:id/tags', async (c) => {
    const body = await c.req.json<{ tag?: unknown }>().catch(() => ({} as { tag?: unknown }));
    const agentResult = sessionManager.get(c.req.param('id'));
    if (!agentResult.ok) return c.json({ error: agentResult.error }, 404);
    const access = leases.checkAgentAccess(agentResult.data, getActingUser(c));
    if (!access.ok) return c.json({ error: access.error }, 403);
    const tag = validateTag(body?.tag);
    if (!tag.ok) return c.json({ error: tag.error }, 400);
    addAgentTag(agentResult.data.id, tag.data);
    emit('agent.tagged', 'agent', agentResult.data.id, { tag: tag.data, name: agentResult.data.name });
    return c.json(enrichAgent(agentResult.data, getActingUser(c)));
  });

  app.delete('/api/agents/:id/tags/:tag', (c) => {
    const agentResult = sessionManager.get(c.req.param('id'));
    if (!agentResult.ok) return c.json({ error: agentResult.error }, 404);
    const access = leases.checkAgentAccess(agentResult.data, getActingUser(c));
    if (!access.ok) return c.json({ error: access.error }, 403);
    if (!removeAgentTag(agentResult.data.id, c.req.param('tag'))) return c.json({ error: 'Tag not set on this agent' }, 404);
    emit('agent.untagged', 'agent', agentResult.data.id, { tag: c.req.param('tag'), name: agentResult.data.name });
    return c.json(enrichAgent(agentResult.data, getActingUser(c)));
  });

  app.post('/api/agents/:id/reserve', async (c) => {
    const body = await c.req.json<{ hours?: unknown }>().catch(() => ({} as { hours?: unknown }));
    const agentResult = sessionManager.get(c.req.param('id'));
    if (!agentResult.ok) return c.json({ error: agentResult.error }, 404);

    const result = leases.reserveAgent(agentResult.data.id, getActingUser(c), body?.hours);
    if (!result.ok) return c.json({ error: result.error }, leases.leaseErrorStatus(result.code));
    return c.json(enrichAgent(result.data, getActingUser(c)));
  });

  app.post('/api/agents/:id/release', (c) => {
    const agentResult = sessionManager.get(c.req.param('id'));
    if (!agentResult.ok) return c.json({ error: agentResult.error }, 404);

    const result = leases.releaseAgent(agentResult.data.id, getActingUser(c));
    if (!result.ok) return c.json({ error: result.error }, leases.leaseErrorStatus(result.code));
    return c.json(enrichAgent(result.data, getActingUser(c)));
  });

  // The models this agent's CLI can use (Codex: its own cache on this profile).
  app.get('/api/agents/:id/models', (c) => {
    const agentResult = sessionManager.get(c.req.param('id'));
    if (!agentResult.ok) return c.json({ error: agentResult.error }, 404);
    return c.json(modelSwitch.listModels(agentResult.data));
  });

  // Pin a model/effort and make the running CLI use it (owner or admin).
  app.post('/api/agents/:id/model', async (c) => {
    const body = await c.req.json<{ model?: string | null; effort?: EffortLevel | null }>().catch(() => ({} as { model?: string | null; effort?: EffortLevel | null }));
    if (body.model === undefined && body.effort === undefined) return c.json({ error: 'Provide model and/or effort (null clears a pin)' }, 400);
    const agentResult = sessionManager.get(c.req.param('id'));
    if (!agentResult.ok) return c.json({ error: agentResult.error }, 404);
    const user = getActingUser(c);
    const access = leases.checkAgentAccess(agentResult.data, user);
    if (!access.ok) return c.json({ error: access.error }, 403);
    const result = await modelSwitch.switchModel(agentResult.data, { model: body.model, effort: body.effort });
    if (!result.ok) return c.json({ error: result.error }, 400);
    logger.info({ agentId: agentResult.data.id, model: result.data.agent.model, effort: result.data.agent.effort, applied: result.data.applied }, 'Agent model switched');
    return c.json({ agent: enrichAgent(result.data.agent, user), applied: result.data.applied, note: result.data.note });
  });

  app.patch('/api/agents/:id', async (c) => {
    const body = await c.req.json<{
      model?: string | null;
      effort?: EffortLevel | null;
      role?: string | null;
      /** Short unique handle, e.g. 'toni' (spec §5c); null clears it. */
      alias?: string | null;
      /** One line, e.g. 'frontend lead'; null clears it. */
      persona?: string | null;
      /** tmux server socket (`-L`). Null or '' clears it. */
      tmux_socket?: string | null;
    }>();

    const role = parseAgentRole(body.role);
    if (!role.ok) return c.json({ error: role.error }, 400);

    const agentResult = sessionManager.get(c.req.param('id'));
    if (!agentResult.ok) return c.json({ error: agentResult.error }, 404);
    let agent = agentResult.data;
    const user = getActingUser(c);

    // Identity / role changes (spec §5b, §5c) are the owner's or an admin's
    const hasIdentity = body.alias !== undefined || body.persona !== undefined;
    if (hasIdentity || role.role !== undefined) {
      const access = leases.checkAgentAccess(agent, user);
      if (!access.ok) return c.json({ error: access.error }, 403);
    }
    if (hasIdentity) {
      const alias = body.alias === undefined ? undefined : validateAlias(body.alias, agent.id);
      if (alias && !alias.ok) return c.json({ error: alias.error }, alias.error.includes('already') || alias.error.includes('is a') ? 409 : 400);
      const persona = body.persona === undefined ? undefined : validatePersona(body.persona);
      if (persona && !persona.ok) return c.json({ error: persona.error }, 400);
      const updated = updateAgentIdentity(agent.id, {
        ...(alias ? { alias: alias.data } : {}),
        ...(persona ? { persona: persona.data } : {}),
      });
      if (!updated.ok) return c.json({ error: updated.error }, updated.error.includes('taken') ? 409 : 500);
      emit('agent.renamed', 'agent', agent.id, {
        name: agent.name,
        alias: updated.data.alias ?? null,
        previous_alias: agent.alias ?? null,
        persona: updated.data.persona ?? null,
      });
      agent = updated.data;
    }
    if (role.role !== undefined) agent = assignRole(agent, role.role, user.id);
    if (body.tmux_socket !== undefined) {
      const socket = body.tmux_socket == null || body.tmux_socket === '' ? null : body.tmux_socket.trim();
      if (socket && !/^[a-zA-Z0-9._-]+$/.test(socket)) {
        return c.json({ error: 'tmux_socket must be a tmux socket name (letters, numbers, hyphens, underscores, dots)' }, 400);
      }
      const updated = updateAgentSocket(agent.id, socket);
      if (!updated.ok) return c.json({ error: updated.error }, 500);
      bindSessionSocket(updated.data.tmux_session, socket);
      agent = await sessionManager.reprobeAgent(updated.data);
    }
    if (body.model === undefined && body.effort === undefined) {
      if (!hasIdentity && role.role === undefined && body.tmux_socket === undefined) {
        return c.json({ error: 'Provide alias, persona, role, model, effort and/or tmux_socket' }, 400);
      }
      return c.json(enrichAgent(agent, user));
    }

    const validationError = validate.validateAgentPinBody(body);
    if (validationError) return c.json({ error: validationError }, 400);

    const result = updateAgentPin(agent.id, {
      model: body.model,
      effort: body.effort,
    });
    if (!result.ok) return c.json({ error: result.error }, 500);

    emit('agent.updated', 'agent', result.data.id, {
      name: result.data.name,
      model: result.data.model,
      effort: result.data.effort,
    });

    logger.info(
      { agentId: result.data.id, model: result.data.model, effort: result.data.effort },
      'Agent pin updated',
    );
    return c.json(enrichAgent(await sessionManager.reprobeAgent(result.data), getActingUser(c)));
  });

  app.post('/api/agents/spawn', async (c) => {
    const body = await c.req.json<{
      name: string;
      runtime: Agent['runtime'];
      repo?: string;
      branch?: string;
      model?: string | null;
      effort?: EffortLevel | null;
      runner?: 'tmux' | 'file';
      /** Reserve the new agent for the caller (spec §3: MCP spawn_agent sends 4). */
      reserve_hours?: number;
      /** Credential profile (spec §5) — admin only; default is the caller's own. */
      profile?: string | null;
      /** 'orchestrator' = the PM seat; it is sent docs/orchestrator-seat.md once up (spec §5b). */
      role?: string | null;
    }>();

    const spawnValidation = validate.validateSpawnBody(body);
    if (spawnValidation) return c.json({ error: spawnValidation }, 400);
    const role = parseAgentRole(body.role);
    if (!role.ok) return c.json({ error: role.error }, 400);
    if (role.role && body.runner === 'file') return c.json({ error: 'File-runner seats cannot hold the orchestrator role' }, 400);
    const reserveHours = body.reserve_hours;
    if (reserveHours !== undefined && (typeof reserveHours !== 'number' || !Number.isFinite(reserveHours)
      || reserveHours <= 0 || reserveHours > leases.MAX_RESERVE_HOURS)) {
      return c.json({ error: `reserve_hours must be a number in (0, ${leases.MAX_RESERVE_HOURS}]` }, 400);
    }

    const profile = resolveSpawnProfile(getActingUser(c), body.profile);
    // Self-service quota: a developer's own profile carries at most spawn.max_per_user agents
    if (profile.ok && profile.data && !isAdmin(getActingUser(c))) {
      const max = getConfig().spawn?.max_per_user ?? null;
      if (max !== null && max >= 0) {
        const mine = listAgents().filter((a) => a.profile === profile.data && !a.tmux_session.startsWith('wc-login-')).length;
        if (mine >= max) return c.json({ error: `Profile '${profile.data}' already runs ${mine} agent${mine === 1 ? '' : 's'} (limit ${max}). Stop one first, or ask an admin.` }, 429);
      }
    }
    if (!profile.ok) return c.json({ error: profile.error }, profile.code === 'forbidden' ? 403 : 400);
    // Never start a CLI that would sit at its login menu (spec §5).
    const login = requireProfileLogin(profile.data, body.runtime);
    if (!login.ok) return c.json({ error: login.error }, 409);

    const result = await sessionManager.spawnAgent({ ...body, profile: profile.data });
    if (!result.ok) return c.json({ error: result.error }, 400);

    const agent = role.role ? assignRole(result.data, role.role, getActingUser(c).id) : result.data;
    outputWatcher.startWatching(agent.id);
    emit('agent.spawned', 'agent', agent.id, {
      name: agent.name,
      runtime: agent.runtime,
      tmuxSession: agent.tmux_session,
      workspace: agent.workspace,
      model: agent.model,
      effort: agent.effort,
      runner: agent.mode === 'file' ? 'file' : 'tmux',
      profile: agent.profile ?? null,
    });

    logger.info({ agentId: agent.id, session: agent.tmux_session }, 'Agent spawned');

    if (reserveHours !== undefined) {
      const user = getActingUser(c);
      const reserved = leases.reserveAgent(agent.id, user, reserveHours);
      if (!reserved.ok) {
        logger.warn({ agentId: agent.id, error: reserved.error }, 'Spawned agent could not be reserved');
        return c.json({ ...enrichAgent(agent, user), reserve_error: reserved.error }, 201);
      }
      return c.json(enrichAgent(reserved.data, user), 201);
    }
    return c.json(agent, 201);
  });
}

/**
 * Store the role; becoming the orchestrator sends the standing operating
 * prompt once the runtime is up (async — the response does not wait).
 */
function assignRole(agent: Agent, role: AgentRole | null, actorId: string): Agent {
  const updated = updateAgentRole(agent.id, role);
  if (!updated.ok) return agent;
  emit('agent.updated', 'agent', agent.id, { name: agent.name, role });
  if (role === 'orchestrator' && agent.role !== 'orchestrator') {
    void briefOrchestratorSeat(agent.id, actorId).catch((err) =>
      logger.warn({ agentId: agent.id, error: (err as Error).message }, 'Orchestrator brief failed'),
    );
  }
  return updated.data;
}

/** Tags for every agent; tolerant of a DB without the table (embedded/test mocks). */
function safeAllTags(): Map<string, string[]> | null {
  try {
    return listAllAgentTags();
  } catch {
    return null;
  }
}

function safeUsage(agent: Agent) {
  try { return usageFor(agent.runtime, agent.profile ?? null); } catch { return null; }
}

function enrichAgent(agent: Agent, viewer: User, orchestratorId?: string | null, tags?: string[]) {
  const owner = agent.owner_id ? leases.userName(agent.owner_id) : null;
  const live = outputWatcher.getLiveModel(agent.id);
  const mismatch = modelSwitch.pinDiffersFromLive(agent, live);
  const defaultSeat = orchestratorId === undefined ? defaultSeatFor(viewer, listAgents())?.id ?? null : orchestratorId;
  return {
    ...agent,
    owner,
    /** What the CLI's own footer says it runs (Codex); null when it shows none. */
    live_model: live,
    /** A pin exists and the CLI shows something else: the guard reapplies it when the agent is idle. */
    model_mismatch: mismatch,
    /** Group tags (spec §5c) */
    tags: tags ?? safeAllTags()?.get(agent.id) ?? [],
    /** The Command Center's default recipient (spec §5b). */
    orchestrator: defaultSeat === agent.id,
    // Spec §3: lease state for orchestrators, plus whether *this* caller may
    // act on the agent (rule 2) so MCP seats never have to guess.
    lease: agent.owner_id
      ? { owner, owner_id: agent.owner_id, reason: agent.lease_reason ?? null, expires_at: agent.lease_expires_at ?? null }
      : null,
    can_act: leases.checkAgentAccess(agent, viewer).ok,
    // Spec §5: a free agent on another subscription is "free (other subscription)" — never yours to use.
    profile_compatible: !agent.profile || isProfileCompatible(agent.profile, viewer),
    // Whose subscription this agent burns (account label + plan; never tokens).
    subscription: subscriptionFor(agent.runtime, agent.profile ?? null),
    // What the CLI runs with when nothing is pinned (its own settings on that profile).
    runtime_defaults: runtimeDefaultsFor(agent.runtime, agent.profile ?? null),
    // Plan usage read from the CLI's own status screen (usage-probe.ts); null until the first probe
    usage: safeUsage(agent),
    lastOutputLine: outputWatcher.getLastOutputLine(agent.id),
    outputVersion: outputWatcher.getOutputVersion(agent.id),
    watching: outputWatcher.isWatching(agent.id),
  };
}

function cleanCapturedOutput(output: string): string {
  return output
    // OSC sequences (terminal hyperlinks \e]8;;url\e\\, titles): the HTML renderer cannot show them and they garble links
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .split('\n')
    .map((line) => {
      const stripped = line.replace(/\x1b\[[0-9;]*m/g, '').trim();
      if (/^[─═━\-=~_]{20,}$/.test(stripped)) {
        return stripped.substring(0, 40);
      }
      return line.trimEnd();
    })
    .join('\n');
}

async function renderAnsiHtml(output: string): Promise<string> {
  const AnsiToHtml = (await import('ansi-to-html')).default;
  const converter = new AnsiToHtml({
    fg: '#94a3b8',
    bg: 'transparent',
    newline: true,
    escapeXML: true,
    colors: {
      0: '#334155',
      1: '#f87171',
      2: '#4ade80',
      3: '#fbbf24',
      4: '#60a5fa',
      5: '#c084fc',
      6: '#22d3ee',
      7: '#e2e8f0',
      8: '#475569',
      9: '#fca5a5',
      10: '#86efac',
      11: '#fde68a',
      12: '#93c5fd',
      13: '#d8b4fe',
      14: '#67e8f9',
      15: '#f8fafc',
    },
  });

  return converter.toHtml(output);
}
