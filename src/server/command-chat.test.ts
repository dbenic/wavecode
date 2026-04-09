import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('command-chat.ts', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wavecode-chat-test-'));
    dbPath = path.join(tmpDir, 'test.db');
  });

  afterEach(async () => {
    const { resetDbForTest } = await import('./db.js');
    resetDbForTest();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetModules();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns the newest chat messages while preserving chronological order', async () => {
    const db = await import('./db.js');
    db.initDb(dbPath);

    const chat = await import('./command-chat.js');
    chat.ensureChatTable();

    for (let i = 0; i < 60; i++) {
      chat.insertChatMessage(i % 2 === 0 ? 'user' : 'assistant', `message-${i}`);
    }

    const history = chat.getChatHistory(30);

    expect(history).toHaveLength(30);
    expect(history[0].content).toBe('message-30');
    expect(history[history.length - 1].content).toBe('message-59');
  });

  it('spawns a codex agent directly from an explicit chat command without requiring the LLM API key', async () => {
    vi.doMock('./config.js', () => ({
      getAnthropicApiKey: vi.fn(() => null),
      getConfig: vi.fn(() => ({
        runtimes: {
          'claude-code': { command: 'claude --dangerously-skip-permissions', idle_pattern: '\\$\\s*$' },
          codex: { command: 'codex --full-auto', idle_pattern: '^>\\s*$' },
          aider: { command: 'aider --yes', idle_pattern: '^>\\s*$' },
        },
        llm: { model: 'claude-sonnet-4-20250514' },
      })),
    }));

    vi.doMock('./session-manager.js', () => ({
      spawnAgent: vi.fn(() => ({
        ok: true,
        data: {
          id: 'agent-1',
          name: 'projectXfrontend',
          runtime: 'codex',
          tmux_session: 'wc-projectXfrontend',
          workspace: null,
          mode: 'spawned',
          status: 'idle',
          created_at: '2026-04-04T00:00:00Z',
        },
      })),
    }));

    const db = await import('./db.js');
    db.initDb(dbPath);

    const chat = await import('./command-chat.js');
    chat.ensureChatTable();

    const result = await chat.chat('start a new agent using codex named projectXfrontend');
    const sessionManager = await import('./session-manager.js');

    expect(sessionManager.spawnAgent).toHaveBeenCalledWith({
      name: 'projectXfrontend',
      runtime: 'codex',
      repo: undefined,
      branch: undefined,
    });
    expect(result.reply).toContain('projectXfrontend');
    expect(result.reply).toContain('codex');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toContain('spawn_agent');

    const history = chat.getChatHistory(2);
    expect(history.map((message) => message.role)).toEqual(['user', 'assistant']);
  });

  it('maps "claude" chat commands to the claude-code runtime', async () => {
    vi.doMock('./config.js', () => ({
      getAnthropicApiKey: vi.fn(() => null),
      getConfig: vi.fn(() => ({
        runtimes: {
          'claude-code': { command: 'claude --dangerously-skip-permissions', idle_pattern: '\\$\\s*$' },
          codex: { command: 'codex --full-auto', idle_pattern: '^>\\s*$' },
        },
        llm: { model: 'claude-sonnet-4-20250514' },
      })),
    }));

    vi.doMock('./session-manager.js', () => ({
      spawnAgent: vi.fn(() => ({
        ok: true,
        data: {
          id: 'agent-2',
          name: 'projectXfrontend',
          runtime: 'claude-code',
          tmux_session: 'wc-projectXfrontend',
          workspace: null,
          mode: 'spawned',
          status: 'idle',
          created_at: '2026-04-04T00:00:00Z',
        },
      })),
    }));

    const db = await import('./db.js');
    db.initDb(dbPath);

    const chat = await import('./command-chat.js');
    chat.ensureChatTable();

    await chat.chat('launch an agent with claude named projectXfrontend');
    const sessionManager = await import('./session-manager.js');

    expect(sessionManager.spawnAgent).toHaveBeenCalledWith({
      name: 'projectXfrontend',
      runtime: 'claude-code',
      repo: undefined,
      branch: undefined,
    });
  });

  it('passes repo and branch arguments through direct spawn commands', async () => {
    vi.doMock('./config.js', () => ({
      getAnthropicApiKey: vi.fn(() => null),
      getConfig: vi.fn(() => ({
        runtimes: {
          codex: { command: 'codex --full-auto', idle_pattern: '^>\\s*$' },
        },
        llm: { model: 'claude-sonnet-4-20250514' },
      })),
    }));

    vi.doMock('./session-manager.js', () => ({
      spawnAgent: vi.fn(() => ({
        ok: true,
        data: {
          id: 'agent-3',
          name: 'projectx-frontend',
          runtime: 'codex',
          tmux_session: 'wc-projectx-frontend',
          workspace: '/tmp/project-x',
          mode: 'spawned',
          status: 'idle',
          created_at: '2026-04-04T00:00:00Z',
        },
      })),
    }));

    const db = await import('./db.js');
    db.initDb(dbPath);

    const chat = await import('./command-chat.js');
    chat.ensureChatTable();

    await chat.chat('start a new agent using codex named projectx-frontend in repo "/tmp/project-x" branch feat-ui');
    const sessionManager = await import('./session-manager.js');

    expect(sessionManager.spawnAgent).toHaveBeenCalledWith({
      name: 'projectx-frontend',
      runtime: 'codex',
      repo: '/tmp/project-x',
      branch: 'feat-ui',
    });
  });

  it('parses natural create-agent phrasing without requiring the LLM', async () => {
    vi.doMock('./config.js', () => ({
      getAnthropicApiKey: vi.fn(() => null),
      getConfig: vi.fn(() => ({
        runtimes: {
          codex: { command: 'codex --full-auto', idle_pattern: '^>\\s*$' },
        },
        llm: { model: 'claude-sonnet-4-20250514' },
      })),
    }));

    vi.doMock('./session-manager.js', () => ({
      spawnAgent: vi.fn(() => ({
        ok: true,
        data: {
          id: 'agent-4',
          name: 'builder',
          runtime: 'codex',
          tmux_session: 'wc-builder',
          workspace: null,
          mode: 'spawned',
          status: 'idle',
          created_at: '2026-04-04T00:00:00Z',
        },
      })),
    }));

    const db = await import('./db.js');
    db.initDb(dbPath);

    const chat = await import('./command-chat.js');
    chat.ensureChatTable();

    const result = await chat.chat('create a codex agent builder');
    const sessionManager = await import('./session-manager.js');

    expect(sessionManager.spawnAgent).toHaveBeenCalledWith({
      name: 'builder',
      runtime: 'codex',
      repo: undefined,
      branch: undefined,
    });
    expect(result.reply).toContain('builder');
  });

  it('returns a specific parse error for explicit spawn intent when the LLM is unavailable', async () => {
    vi.doMock('./config.js', () => ({
      getAnthropicApiKey: vi.fn(() => null),
      getConfig: vi.fn(() => ({
        runtimes: {
          'claude-code': { command: 'claude --dangerously-skip-permissions', idle_pattern: '\\$\\s*$' },
          codex: { command: 'codex --full-auto', idle_pattern: '^>\\s*$' },
        },
        llm: { model: 'claude-sonnet-4-20250514' },
      })),
    }));

    vi.doMock('./session-manager.js', () => ({
      spawnAgent: vi.fn(),
    }));

    const db = await import('./db.js');
    db.initDb(dbPath);

    const chat = await import('./command-chat.js');
    chat.ensureChatTable();

    const result = await chat.chat('please create an agent for me');

    expect(result.reply).toContain('I detected an agent creation request');
    expect(result.reply).toContain('Available runtimes:');
  });

  it('creates a team directly from chat instructions', async () => {
    vi.doMock('./team-manager.js', () => ({
      createTeam: vi.fn(() => ({
        ok: true,
        data: { id: 'team-1', name: 'project-x', description: '' },
      })),
      addMember: vi.fn(() => ({ ok: true, data: undefined })),
      startCommsWatcher: vi.fn(),
    }));

    vi.doMock('./session-manager.js', () => ({
      get: vi.fn((name: string) => ({
        ok: true,
        data: { id: `${name}-id`, name },
      })),
    }));

    const db = await import('./db.js');
    db.initDb(dbPath);

    const chat = await import('./command-chat.js');
    chat.ensureChatTable();

    const result = await chat.chat(
      'Create a team named project-x with productmanager as lead, projectx-frontend as frontend, projectx-backend as backend',
    );

    const teamManager = await import('./team-manager.js');
    expect(teamManager.createTeam).toHaveBeenCalledWith('project-x', '');
    expect(teamManager.addMember).toHaveBeenCalledWith('team-1', 'productmanager-id', 'lead');
    expect(teamManager.addMember).toHaveBeenCalledWith('team-1', 'projectx-frontend-id', 'frontend');
    expect(teamManager.addMember).toHaveBeenCalledWith('team-1', 'projectx-backend-id', 'backend');
    expect(teamManager.startCommsWatcher).toHaveBeenCalledWith('project-x');
    expect(result.reply).toContain('Team "project-x" created');
  });

  it('hands off the default project spec file directly from chat instructions', async () => {
    vi.doMock('./session-manager.js', () => ({
      get: vi.fn((name: string) => ({
        ok: true,
        data: { id: `${name}-id`, name },
      })),
    }));

    vi.doMock('./file-sharing.js', () => ({
      shareFile: vi.fn(() => ({
        ok: true,
        data: {
          filename: 'spec.md',
          version: 1,
          from_agent_name: 'productmanager',
          to_agent_name: 'projectx-frontend',
          category: 'spec',
        },
      })),
    }));

    const db = await import('./db.js');
    db.initDb(dbPath);

    const chat = await import('./command-chat.js');
    chat.ensureChatTable();

    const result = await chat.chat('handoff spec from productmanager to projectx-frontend');
    const fileSharing = await import('./file-sharing.js');

    expect(fileSharing.shareFile).toHaveBeenCalledWith({
      fromAgentId: 'productmanager-id',
      toAgentId: 'projectx-frontend-id',
      filePath: 'docs/spec.md',
      category: 'spec',
      purpose: 'Read this specification carefully and implement from it.',
    });
    expect(result.reply).toContain('Shared "spec.md"');
  });

  it('creates a dependent task graph directly from structured chat input', async () => {
    vi.useFakeTimers();
    const agentIds: Record<string, string> = {};

    vi.doMock('./config.js', () => ({
      getAnthropicApiKey: vi.fn(() => null),
      getConfig: vi.fn(() => ({
        runtimes: {
          codex: { command: 'codex --full-auto', idle_pattern: '^>\\s*$' },
        },
        llm: { model: 'claude-sonnet-4-20250514' },
      })),
    }));

    vi.doMock('./session-manager.js', () => ({
      get: vi.fn((name: string) => ({
        ok: !!agentIds[name],
        data: { id: agentIds[name], name },
        error: agentIds[name] ? undefined : `Agent '${name}' not found`,
      })),
    }));

    vi.doMock('./task-dispatcher.js', () => ({
      dispatchNext: vi.fn(),
      addDependency: vi.fn(() => true),
    }));

    const db = await import('./db.js');
    db.initDb(dbPath);
    const frontendAgent = db.insertAgent({
      name: 'projectx-frontend',
      runtime: 'codex',
      tmux_session: 'wc-projectx-frontend',
      workspace: null,
      mode: 'spawned',
      status: 'idle',
    });
    expect(frontendAgent.ok).toBe(true);
    if (!frontendAgent.ok) throw new Error(frontendAgent.error);
    agentIds['projectx-frontend'] = frontendAgent.data.id;

    const backendAgent = db.insertAgent({
      name: 'projectx-backend',
      runtime: 'codex',
      tmux_session: 'wc-projectx-backend',
      workspace: null,
      mode: 'spawned',
      status: 'idle',
    });
    expect(backendAgent.ok).toBe(true);
    if (!backendAgent.ok) throw new Error(backendAgent.error);
    agentIds['projectx-backend'] = backendAgent.data.id;

    const deployAgent = db.insertAgent({
      name: 'projectx-deploy',
      runtime: 'codex',
      tmux_session: 'wc-projectx-deploy',
      workspace: null,
      mode: 'spawned',
      status: 'idle',
    });
    expect(deployAgent.ok).toBe(true);
    if (!deployAgent.ok) throw new Error(deployAgent.error);
    agentIds['projectx-deploy'] = deployAgent.data.id;

    const chat = await import('./command-chat.js');
    chat.ensureChatTable();

    const result = await chat.chat(`Create dependent task graph:
- projectx-frontend: Build the frontend from docs/spec.md
- projectx-backend: Build the backend API from docs/spec.md
- projectx-deploy: Deploy the application`);
    vi.runAllTimers();

    const tasks = db.listTasks();
    const taskDispatcher = await import('./task-dispatcher.js');

    expect(result.reply).toContain('Pipeline created');
    expect(tasks).toHaveLength(3);
    expect(taskDispatcher.addDependency).toHaveBeenCalledTimes(2);
    expect(taskDispatcher.addDependency).toHaveBeenNthCalledWith(1, tasks[1].id, tasks[0].id);
    expect(taskDispatcher.addDependency).toHaveBeenNthCalledWith(2, tasks[2].id, tasks[1].id);
    expect(result.reply).toContain('Pipeline created');
  });

  it('uses an OpenAI-compatible tool-calling backend for free-form chat orchestration', async () => {
    vi.doMock('./config.js', () => ({
      getConfig: vi.fn(() => ({
        runtimes: {
          codex: { command: 'codex --full-auto', idle_pattern: '^>\\s*$' },
        },
        llm: {
          provider: 'openai-compatible',
          api_key: null,
          anthropic_api_key: null,
          openai_api_key: null,
          gemini_api_key: null,
          perplexity_api_key: null,
          xai_api_key: null,
          base_url: 'http://127.0.0.1:11434/v1',
          model: 'gemma4',
        },
      })),
    }));

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call_1',
              type: 'function',
              function: {
                name: 'list_agents',
                arguments: '{}',
              },
            }],
          },
        }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{
          message: {
            role: 'assistant',
            content: 'No agents are running right now.',
          },
        }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    const db = await import('./db.js');
    db.initDb(dbPath);

    const chat = await import('./command-chat.js');
    chat.ensureChatTable();

    const result = await chat.chat('what agents are running right now?');

    expect(result.reply).toContain('No agents are running right now.');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toContain('list_agents');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:11434/v1/chat/completions');
    expect(options.method).toBe('POST');

    const body = JSON.parse(options.body as string) as {
      model: string;
      tools: Array<{ function: { name: string } }>;
    };
    expect(body.model).toBe('gemma4');
    expect(body.tools.some((tool) => tool.function.name === 'list_agents')).toBe(true);
  });
});
