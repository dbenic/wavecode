import type { Hono } from 'hono';
import {
  listAgents,
  getAgent,
  updateAgentPin,
  type Agent,
  type EffortLevel,
} from '../db.js';
import { emit } from '../event-bus.js';
import * as sessionManager from '../session-manager.js';
import * as outputWatcher from '../output-watcher.js';
import * as validate from '../validate.js';
import logger from '../logger.js';
import { getActingUser, type NodeAppEnv } from '../auth.js';
import type { User } from '../db.js';
import * as leases from '../leases.js';
import * as runtimeLiveness from '../runtime-liveness.js';
import { isProfileCompatible, resolveSpawnProfile } from '../profiles.js';

export function registerAgentRoutes(app: Hono<NodeAppEnv>): void {
  app.get('/api/agents', (c) => {
    const agents = listAgents();
    return c.json(agents.map((a) => enrichAgent(a, getActingUser(c))));
  });

  app.get('/api/agents/:id', (c) => {
    const result = sessionManager.get(c.req.param('id'));
    if (!result.ok) return c.json({ error: result.error }, 404);
    return c.json(enrichAgent(result.data, getActingUser(c)));
  });

  app.post('/api/agents/scan', (c) => {
    const result = sessionManager.scan();
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
    }>();

    const validationError = validate.validateAdoptBody(body);
    if (validationError) return c.json({ error: validationError }, 400);

    const result = sessionManager.adopt(body.sessionName, body.runtime, body.name);
    if (!result.ok) return c.json({ error: result.error }, 400);

    const agent = result.data;
    outputWatcher.startWatching(agent.id);

    emit('agent.adopted', 'agent', agent.id, {
      name: agent.name,
      runtime: agent.runtime,
      tmuxSession: agent.tmux_session,
    });

    logger.info({ agentId: agent.id, session: agent.tmux_session }, 'Agent adopted');
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

    if (body.raw) {
      const result = sessionManager.sendRawKeys(agentResult.data.id, body.text);
      if (!result.ok) return c.json({ error: result.error }, 500);
    } else {
      const result = sessionManager.sendKeys(agentResult.data.id, body.text);
      if (!result.ok) return c.json({ error: result.error }, 500);
    }

    emit('agent.prompt_sent', 'agent', agentResult.data.id, {
      text: body.text.substring(0, 200),
    });

    return c.json({ ok: true });
  });

  app.get('/api/agents/:id/output', async (c) => {
    const agentResult = sessionManager.get(c.req.param('id'));
    if (!agentResult.ok) return c.json({ error: agentResult.error }, 404);

    const lines = validate.validateIntParam(c.req.query('lines'), { min: 1, max: 500, default: 50 });
    const useAnsi = c.req.query('ansi') === 'true';

    if (useAnsi) {
      const result = sessionManager.capturePaneAnsi(agentResult.data.tmux_session, lines);
      if (!result.ok) return c.json({ error: result.error }, 500);

      const cleaned = cleanCapturedOutput(result.data);
      return c.json({
        output: cleaned,
        html: await renderAnsiHtml(cleaned),
      });
    }

    const result = sessionManager.capturePane(agentResult.data.tmux_session, lines);
    if (!result.ok) return c.json({ error: result.error }, 500);

    return c.json({ output: cleanCapturedOutput(result.data) });
  });

  app.get('/api/agents/:id/scrollback', async (c) => {
    const agentResult = sessionManager.get(c.req.param('id'));
    if (!agentResult.ok) return c.json({ error: agentResult.error }, 404);

    const session = agentResult.data.tmux_session;
    const start = validate.validateIntParam(c.req.query('start'), { min: -10000, max: 0, default: -200 });
    const end = validate.validateIntParam(c.req.query('end'), { min: -10000, max: 0, default: -100 });
    const sizeResult = sessionManager.getScrollbackSize(session);
    const totalLines = sizeResult.ok ? sizeResult.data : 0;

    const result = sessionManager.capturePaneRange(session, start, end);
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

  app.post('/api/agents/:id/kill', (c) => {
    const agentResult = sessionManager.get(c.req.param('id'));
    if (!agentResult.ok) return c.json({ error: agentResult.error }, 404);

    const agent = agentResult.data;
    const access = leases.checkAgentAccess(agent, getActingUser(c));
    if (!access.ok) return c.json({ error: access.error }, 403);
    outputWatcher.stopWatching(agent.id);

    const result = sessionManager.kill(agent.id);
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
  app.post('/api/agents/:id/restart', (c) => {
    const agentResult = sessionManager.get(c.req.param('id'));
    if (!agentResult.ok) return c.json({ error: agentResult.error }, 404);
    const agent = agentResult.data;
    const access = leases.checkAgentAccess(agent, getActingUser(c));
    if (!access.ok) return c.json({ error: access.error }, 403);

    if (agent.mode === 'spawned') {
      const ensured = sessionManager.ensureSpawnedAgentSession(agent.id);
      if (!ensured.ok) return c.json({ error: ensured.error }, 400);
      if (ensured.data.createdSession) {
        outputWatcher.startWatching(agent.id);
        emit('agent.restarted', 'agent', agent.id, { name: agent.name });
        return c.json({ ok: true, action: 'session_recreated' });
      }
    }

    const state = runtimeLiveness.getRuntimeState(agent);
    if (state === 'dead') {
      const relaunched = runtimeLiveness.relaunchRuntime(agent, 'manual');
      if (!relaunched.ok) return c.json({ error: relaunched.error }, 400);
      return c.json({ ok: true, action: relaunched.data.sent ? 'runtime_relaunched' : 'relaunch_in_progress' });
    }
    if (state === 'unknown') {
      return c.json({ error: `Session '${agent.tmux_session}' is not running and cannot be restarted` }, 400);
    }
    return c.json({ ok: true, action: 'already_running' });
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

  app.patch('/api/agents/:id', async (c) => {
    const body = await c.req.json<{
      model?: string | null;
      effort?: EffortLevel | null;
    }>();

    const validationError = validate.validateAgentPinBody(body);
    if (validationError) return c.json({ error: validationError }, 400);

    const agentResult = sessionManager.get(c.req.param('id'));
    if (!agentResult.ok) return c.json({ error: agentResult.error }, 404);

    const result = updateAgentPin(agentResult.data.id, {
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
    return c.json(enrichAgent(result.data, getActingUser(c)));
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
    }>();

    const spawnValidation = validate.validateSpawnBody(body);
    if (spawnValidation) return c.json({ error: spawnValidation }, 400);
    const reserveHours = body.reserve_hours;
    if (reserveHours !== undefined && (typeof reserveHours !== 'number' || !Number.isFinite(reserveHours)
      || reserveHours <= 0 || reserveHours > leases.MAX_RESERVE_HOURS)) {
      return c.json({ error: `reserve_hours must be a number in (0, ${leases.MAX_RESERVE_HOURS}]` }, 400);
    }

    const profile = resolveSpawnProfile(getActingUser(c), body.profile);
    if (!profile.ok) return c.json({ error: profile.error }, profile.code === 'forbidden' ? 403 : 400);

    const result = sessionManager.spawnAgent({ ...body, profile: profile.data });
    if (!result.ok) return c.json({ error: result.error }, 400);

    const agent = result.data;
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

function enrichAgent(agent: Agent, viewer: User) {
  const owner = agent.owner_id ? leases.userName(agent.owner_id) : null;
  return {
    ...agent,
    owner,
    // Spec §3: lease state for orchestrators, plus whether *this* caller may
    // act on the agent (rule 2) so MCP seats never have to guess.
    lease: agent.owner_id
      ? { owner, owner_id: agent.owner_id, reason: agent.lease_reason ?? null, expires_at: agent.lease_expires_at ?? null }
      : null,
    can_act: leases.checkAgentAccess(agent, viewer).ok,
    // Spec §5: a free agent on another subscription is "free (other subscription)" — never yours to use.
    profile_compatible: !agent.profile || isProfileCompatible(agent.profile, viewer),
    lastOutputLine: outputWatcher.getLastOutputLine(agent.id),
    outputVersion: outputWatcher.getOutputVersion(agent.id),
    watching: outputWatcher.isWatching(agent.id),
  };
}

function cleanCapturedOutput(output: string): string {
  return output
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
