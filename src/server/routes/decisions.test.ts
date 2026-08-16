import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db.js', () => ({
  insertDecision: vi.fn(),
  listDecisions: vi.fn(() => []),
  listAllDecisions: vi.fn(() => []),
  deleteDecision: vi.fn(),
  getAgent: vi.fn(),
}));

vi.mock('../event-bus.js', () => ({
  emit: vi.fn(),
}));

vi.mock('../briefing-builder.js', () => ({
  previewBriefing: vi.fn(),
}));

describe('decision routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('records a decision and lists it', async () => {
    const db = await import('../db.js');
    const events = await import('../event-bus.js');
    const recorded = {
      id: 'dec-1',
      workspace: '/ws/countix',
      summary: 'employee view IS /incoming, stripped by role',
      detail: 'Do not expose payroll fields to employee role',
      source_agent_id: null,
      source_run_id: null,
      created_at: '2026-08-16T00:00:00Z',
    };
    vi.mocked(db.insertDecision).mockReturnValue({ ok: true, data: recorded } as never);
    vi.mocked(db.listDecisions).mockReturnValue([recorded] as never);
    vi.mocked(db.listAllDecisions).mockReturnValue([recorded] as never);

    const app = await createDecisionApp();

    const created = await requestJson(app, '/api/decisions', 'POST', {
      workspace: '/ws/countix',
      summary: 'employee view IS /incoming, stripped by role',
      detail: 'Do not expose payroll fields to employee role',
    });
    expect(created.status).toBe(201);
    expect(created.json).toEqual(recorded);
    expect(db.insertDecision).toHaveBeenCalledWith({
      workspace: '/ws/countix',
      summary: 'employee view IS /incoming, stripped by role',
      detail: 'Do not expose payroll fields to employee role',
      source_agent_id: null,
    });
    expect(events.emit).toHaveBeenCalledWith(
      'decision.created',
      'decision',
      'dec-1',
      expect.objectContaining({ workspace: '/ws/countix' }),
    );

    const listed = await requestJson(app, '/api/decisions?workspace=/ws/countix', 'GET');
    expect(listed.status).toBe(200);
    expect(listed.json).toEqual([recorded]);
    expect(db.listDecisions).toHaveBeenCalledWith('/ws/countix');
  });

  it('rejects a decision without a summary', async () => {
    const app = await createDecisionApp();
    const response = await requestJson(app, '/api/decisions', 'POST', { workspace: '/ws/a' });
    expect(response.status).toBe(400);
    expect(response.json).toEqual({ error: 'summary is required' });
  });
});

async function createDecisionApp() {
  const { registerDecisionRoutes } = await import('./decisions.js');
  const app = new Hono();
  registerDecisionRoutes(app);
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
