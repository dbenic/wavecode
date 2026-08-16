/**
 * Tests for the MCP tool layer: every tool maps to the right REST call,
 * arguments pass through faithfully, and API errors surface as tool errors.
 */

import { describe, expect, it, vi } from 'vitest';
import { WAVECODE_TOOLS } from './tools.js';
import { WaveCodeClient } from './client.js';

function makeClient(response: unknown = { ok: true }, status = 200) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(response), { status }));
  const client = new WaveCodeClient({
    baseUrl: 'http://wavecode.test:3777',
    token: 'secret-token',
    fetchImpl: fetchMock as unknown as typeof fetch,
  });
  return { client, fetchMock };
}

function tool(name: string) {
  const def = WAVECODE_TOOLS.find((t) => t.name === name);
  if (!def) throw new Error(`Tool ${name} not defined`);
  return def;
}

function lastCall(fetchMock: ReturnType<typeof vi.fn>) {
  const [url, init] = fetchMock.mock.calls.at(-1)! as [string, RequestInit];
  return { url, init, body: init.body ? JSON.parse(init.body as string) : undefined };
}

describe('mcp tools', () => {
  it('covers the full orchestration surface', () => {
    const names = WAVECODE_TOOLS.map((t) => t.name);
    for (const required of [
      'list_agents', 'spawn_agent', 'pin_agent', 'kill_agent', 'stop_all',
      'send_prompt', 'get_agent_output', 'create_task', 'list_tasks',
      'list_reviews', 'request_ai_review', 'get_ai_reviews',
      'promote_run', 'retry_run', 'handoff_run', 'reject_run',
      'send_message', 'list_messages',
      'list_goals', 'get_goal', 'create_goal',
      'list_decisions', 'record_decision',
    ]) {
      expect(names).toContain(required);
    }
    // No duplicate names
    expect(new Set(names).size).toBe(names.length);
  });

  it('sends the bearer token on every request', async () => {
    const { client, fetchMock } = makeClient([]);
    await tool('list_agents').handler(client, {});

    const { init } = lastCall(fetchMock);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer secret-token');
  });

  it('spawn_agent posts the pin along with name/runtime', async () => {
    const { client, fetchMock } = makeClient({ id: 'a1' });
    await tool('spawn_agent').handler(client, {
      name: 'grok-fe',
      runtime: 'grok',
      model: 'grok-4.6',
      effort: 'xhigh',
    });

    const { url, init, body } = lastCall(fetchMock);
    expect(url).toBe('http://wavecode.test:3777/api/agents/spawn');
    expect(init.method).toBe('POST');
    expect(body).toEqual({ name: 'grok-fe', runtime: 'grok', model: 'grok-4.6', effort: 'xhigh' });
  });

  it('pin_agent PATCHes the agent with model/effort', async () => {
    const { client, fetchMock } = makeClient({});
    await tool('pin_agent').handler(client, { agent_id: 'a1', model: 'claude-opus-5', effort: 'high' });

    const { url, init, body } = lastCall(fetchMock);
    expect(url).toBe('http://wavecode.test:3777/api/agents/a1');
    expect(init.method).toBe('PATCH');
    expect(body).toEqual({ model: 'claude-opus-5', effort: 'high' });
  });

  it('promote_run forwards the override reason in the expected casing', async () => {
    const { client, fetchMock } = makeClient({});
    await tool('promote_run').handler(client, {
      run_id: 'r1',
      override_reason: 'known-red baseline accepted',
    });

    const { url, body } = lastCall(fetchMock);
    expect(url).toBe('http://wavecode.test:3777/api/reviews/r1/promote');
    expect(body).toEqual({ overrideReason: 'known-red baseline accepted' });
  });

  it('kill_agent and stop_all hit the safety endpoints', async () => {
    const { client, fetchMock } = makeClient({});
    await tool('kill_agent').handler(client, { agent_id: 'a9' });
    expect(lastCall(fetchMock).url).toBe('http://wavecode.test:3777/api/agents/a9/kill');

    await tool('stop_all').handler(client, {});
    expect(lastCall(fetchMock).url).toBe('http://wavecode.test:3777/api/system/stop-all');
  });

  it('await_events converts wait_seconds to wait_ms and forwards filters', async () => {
    const { client, fetchMock } = makeClient({ events: [], last_id: 12 });
    await tool('await_events').handler(client, {
      since_id: 12,
      wait_seconds: 30,
      types: 'run.*,message.created',
    });
    expect(lastCall(fetchMock).url).toBe(
      'http://wavecode.test:3777/api/events/log?since=12&wait_ms=30000&types=run.*%2Cmessage.created',
    );
  });

  it('create_goal posts the goal plus optional external_id', async () => {
    const { client, fetchMock } = makeClient({ goal: { id: 'g1' } });
    await tool('create_goal').handler(client, {
      goal: 'Employee incoming view',
      external_id: 'F-16',
    });

    const { url, init, body } = lastCall(fetchMock);
    expect(url).toBe('http://wavecode.test:3777/api/goals');
    expect(init.method).toBe('POST');
    expect(body).toEqual({ goal: 'Employee incoming view', external_id: 'F-16' });
  });

  it('get_goal and list_goals hit the goals API', async () => {
    const { client, fetchMock } = makeClient([]);
    await tool('list_goals').handler(client, {});
    expect(lastCall(fetchMock).url).toBe('http://wavecode.test:3777/api/goals');

    await tool('get_goal').handler(client, { goal_id: 'F-16' });
    expect(lastCall(fetchMock).url).toBe('http://wavecode.test:3777/api/goals/F-16');
  });

  it('record_decision and list_decisions wrap the decisions API', async () => {
    const { client, fetchMock } = makeClient([]);
    await tool('record_decision').handler(client, {
      workspace: '/ws/countix',
      summary: 'employee view IS /incoming, stripped by role',
    });
    const posted = lastCall(fetchMock);
    expect(posted.url).toBe('http://wavecode.test:3777/api/decisions');
    expect(posted.init.method).toBe('POST');
    expect(posted.body).toEqual({
      workspace: '/ws/countix',
      summary: 'employee view IS /incoming, stripped by role',
    });

    await tool('list_decisions').handler(client, { workspace: '/ws/countix' });
    expect(lastCall(fetchMock).url).toBe(
      'http://wavecode.test:3777/api/decisions?workspace=%2Fws%2Fcountix',
    );
  });

  it('list_messages builds query params from filters', async () => {
    const { client, fetchMock } = makeClient([]);
    await tool('list_messages').handler(client, { to_agent_id: 'a1', limit: 10 });
    expect(lastCall(fetchMock).url).toBe(
      'http://wavecode.test:3777/api/messages?to_agent_id=a1&limit=10',
    );
  });

  it('surfaces daemon errors with the server-provided message', async () => {
    const { client } = makeClient({ error: 'Promotion blocked: no completed review exists for this run.' }, 400);

    await expect(tool('promote_run').handler(client, { run_id: 'r1' }))
      .rejects.toThrow(/Promotion blocked/);
  });

  it('every tool declares a description and a handler', () => {
    for (const def of WAVECODE_TOOLS) {
      expect(def.description.length).toBeGreaterThan(20);
      expect(typeof def.handler).toBe('function');
      expect(def.schema).toBeDefined();
    }
  });
});
