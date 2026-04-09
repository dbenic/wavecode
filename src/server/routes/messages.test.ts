import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db.js', () => ({
  getAgent: vi.fn(),
  insertAgentMessage: vi.fn(),
  listAgentMessages: vi.fn(),
}));

vi.mock('../event-bus.js', () => ({
  emit: vi.fn(),
}));

describe('message routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('rejects empty messages', async () => {
    const app = await createMessageApp();
    const response = await requestJson(app, '/api/messages', 'POST', { message: '   ' });

    expect(response.status).toBe(400);
    expect(response.json).toEqual({ error: 'message is required' });
  });

  it('creates messages and emits message.created events', async () => {
    const db = await import('../db.js');
    const events = await import('../event-bus.js');
    vi.mocked(db.insertAgentMessage).mockReturnValue({
      ok: true,
      data: makeMessage({
        id: 'msg-1',
        to_agent_id: 'agent-2',
        workspace: '/workspace/alpha',
        message_type: 'handoff',
      }),
    } as never);

    const app = await createMessageApp();
    const response = await requestJson(app, '/api/messages', 'POST', {
      from_agent_id: 'agent-1',
      to_agent_id: 'agent-2',
      workspace: '/workspace/alpha',
      message: '  Handing off the API task  ',
      message_type: 'handoff',
    });

    expect(response.status).toBe(201);
    expect(response.json).toEqual(makeMessage({
      id: 'msg-1',
      to_agent_id: 'agent-2',
      workspace: '/workspace/alpha',
      message_type: 'handoff',
    }));
    expect(db.insertAgentMessage).toHaveBeenCalledWith({
      from_agent_id: 'agent-1',
      to_agent_id: 'agent-2',
      workspace: '/workspace/alpha',
      message: 'Handing off the API task',
      message_type: 'handoff',
      ref_task_id: null,
      ref_run_id: null,
    });
    expect(events.emit).toHaveBeenCalledWith(
      'message.created',
      'agent_message',
      'msg-1',
      {
        from_agent_id: null,
        to_agent_id: 'agent-2',
        workspace: '/workspace/alpha',
        message_type: 'handoff',
      },
    );
  });

  it('returns direct and workspace broadcast messages for an agent', async () => {
    const db = await import('../db.js');
    vi.mocked(db.getAgent).mockReturnValue({
      ok: true,
      data: {
        id: 'agent-1',
        workspace: '/workspace/alpha',
      },
    } as never);
    vi.mocked(db.listAgentMessages).mockReturnValue([
      makeMessage({ id: 'msg-direct', to_agent_id: 'agent-1', workspace: '/workspace/alpha' }),
      makeMessage({ id: 'msg-broadcast', to_agent_id: null, workspace: '/workspace/alpha' }),
      makeMessage({ id: 'msg-other-workspace', to_agent_id: null, workspace: '/workspace/beta' }),
      makeMessage({ id: 'msg-other-agent', to_agent_id: 'agent-2', workspace: '/workspace/alpha' }),
    ]);

    const app = await createMessageApp();
    const response = await requestJson(app, '/api/agents/agent-1/messages?limit=2', 'GET');

    expect(response.status).toBe(200);
    expect(response.json).toEqual([
      makeMessage({ id: 'msg-direct', to_agent_id: 'agent-1', workspace: '/workspace/alpha' }),
      makeMessage({ id: 'msg-broadcast', to_agent_id: null, workspace: '/workspace/alpha' }),
    ]);
    expect(db.listAgentMessages).toHaveBeenCalledWith({ to_agent_id: 'agent-1' });
  });
});

async function createMessageApp() {
  const { registerMessageRoutes } = await import('./messages.js');
  const app = new Hono();
  registerMessageRoutes(app);
  return app;
}

async function requestJson(app: Hono, url: string, method: string, body?: unknown) {
  const response = await app.fetch(new Request(`http://localhost${url}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }));

  return {
    status: response.status,
    json: await response.json(),
  };
}

function makeMessage(overrides: Partial<{
  id: string;
  from_agent_id: string | null;
  to_agent_id: string | null;
  workspace: string | null;
  message: string;
  message_type: 'info' | 'request' | 'handoff' | 'result' | 'error';
  ref_task_id: string | null;
  ref_run_id: string | null;
}> = {}) {
  return {
    id: 'msg-1',
    from_agent_id: null,
    to_agent_id: null,
    workspace: null,
    message: 'Handing off the API task',
    message_type: 'info' as const,
    ref_task_id: null,
    ref_run_id: null,
    created_at: '2026-04-08T00:00:00Z',
    ...overrides,
  };
}
