// @vitest-environment jsdom

import '../test-setup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('./views/Dashboard', () => ({
  default: () => <div>Dashboard View</div>,
}));

vi.mock('./views/AgentView', () => ({
  default: () => <div>Agent View</div>,
}));

vi.mock('./views/TaskBoard', () => ({
  default: () => <div>Task Board View</div>,
}));

vi.mock('./views/ReviewQueue', () => ({
  default: () => <div>Review Queue View</div>,
}));

vi.mock('./views/Artifacts', () => ({
  default: () => <div>Artifacts View</div>,
}));

vi.mock('./views/CommandChat', () => ({
  default: () => <div>Command Chat View</div>,
}));

vi.mock('./views/Settings', () => ({
  default: () => <div>Settings View</div>,
}));

vi.mock('./components/BottomNav', () => ({
  default: () => <div>Bottom Nav</div>,
}));

vi.mock('./components/ErrorBanner', () => ({
  default: ({ error }: { error: string | null }) => (error ? <div>{error}</div> : null),
}));

vi.mock('./components/AuthGate', () => ({
  default: () => <div>Auth Gate</div>,
}));

describe('App auth persistence', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let storage: ReturnType<typeof createStorageMock>;

  beforeEach(() => {
    vi.resetModules();
    storage = createStorageMock();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: storage,
    });
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows the auth gate when token auth is enabled and no stored token exists', async () => {
    fetchMock.mockResolvedValue(makeJsonResponse({
      method: 'token',
      tokenConfigured: true,
    }));

    const { default: App } = await import('./App');

    render(
      <MemoryRouter initialEntries={['/settings']}>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Auth Gate')).toBeInTheDocument();
    expect(screen.queryByText('Settings View')).not.toBeInTheDocument();
  });

  it('uses the stored access token to keep the UI unlocked after reload', async () => {
    storage.setItem('wavecode.access_token', 'stored-token');
    fetchMock.mockResolvedValue(makeJsonResponse({
      method: 'token',
      tokenConfigured: true,
    }));

    const { default: App } = await import('./App');

    render(
      <MemoryRouter initialEntries={['/settings']}>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Settings View')).toBeInTheDocument();
    expect(screen.queryByText('Auth Gate')).not.toBeInTheDocument();
    expect(screen.getByText('Bottom Nav')).toBeInTheDocument();
  });
});

function makeJsonResponse(body: unknown, status: number = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: async () => body,
  } as Response;
}

function createStorageMock() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
  };
}
