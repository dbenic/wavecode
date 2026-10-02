// @vitest-environment jsdom

import '../../../test-setup';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import RoomView, { sendFilePrompt } from './RoomView';
import type { Agent } from '../../types';
import type { SSEEvent } from '../../hooks/useSSE';

vi.mock('../../hooks/useApi', () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(async () => ({ ok: true })),
  apiPut: vi.fn(async () => ({ path: 'ROOM.md', size: 10 })),
}));

const ROOMS = [
  { project: 'notes', root: '/data/rooms/notes', owner: 'bob', can_write_spec: false },
  { project: 'shop', root: '/data/rooms/shop', owner: 'ana', can_write_spec: true, is_default: true },
];
const DOCS = [
  { path: 'SPEC.md', size: 10, modified_at: '', writable: false },
  { path: 'ROOM.md', size: 10, modified_at: '', writable: true },
  { path: 'REPORTS/2026-10-02-task1-review-r0.md', size: 10, modified_at: '', writable: true },
];
const CONTENT: Record<string, string> = {
  'SPEC.md': '# Shop\n\nWe are building a checkout with **Apple Pay**.',
  'ROOM.md': '# Room\n\n## Current goal\nship v1',
};

function agent(over: Partial<Agent>): Agent {
  return { id: over.name!, name: 'x', runtime: 'claude-code', tmux_session: 'wc', workspace: null, mode: 'spawned', status: 'idle', model: null, effort: null, created_at: '', can_act: true, ...over };
}

async function setup(lastEvent: SSEEvent | null = null) {
  const api = await import('../../hooks/useApi');
  vi.mocked(api.apiGet).mockImplementation(async (path: string) => {
    if (path === '/rooms') return ROOMS as never;
    if (/^\/rooms\/[^/]+\/docs$/.test(path)) return { docs: DOCS } as never;
    const m = /^\/rooms\/[^/]+\/docs\/(.+)$/.exec(path);
    if (m) {
      const p = m[1].split('/').map(decodeURIComponent).join('/');
      return { path: p, content: CONTENT[p] ?? '', writable: DOCS.find((d) => d.path === p)?.writable ?? false } as never;
    }
    throw new Error(`unexpected ${path}`);
  });
  const view = render(<RoomView agents={[agent({ name: 'builder', alias: 'bob-b' }), agent({ name: 'theirs', can_act: false })]} lastEvent={lastEvent} />);
  await screen.findByTestId('room-doc');
  return { api, view };
}

describe('RoomView (spec §5e)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('opens the default room on SPEC.md, rendered; files show who may write them', async () => {
    await setup();
    expect(screen.getByRole('combobox', { name: 'Room' })).toHaveValue('shop');
    await waitFor(() => expect(screen.getByTestId('room-doc')).toHaveTextContent('We are building a checkout with Apple Pay.'));
    expect(screen.getByTestId('room-doc').querySelector('strong')?.textContent).toBe('Apple Pay');
    const files = within(screen.getByRole('list', { name: 'Room files' })).getAllByRole('button').map((b) => b.textContent);
    expect(files).toEqual(['SPEC.md 🔒', 'ROOM.md', 'REPORTS/2026-10-02-task1-review-r0.md']);
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull(); // SPEC.md is read-only for this viewer
  });

  it('edits a writable file inline and saves it', async () => {
    const { api } = await setup();
    await userEvent.click(screen.getByRole('button', { name: 'ROOM.md' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    const box = screen.getByLabelText('Edit ROOM.md');
    await userEvent.clear(box);
    await userEvent.type(box, '# Room{Enter}{Enter}## Current goal{Enter}ship v2');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.apiPut).toHaveBeenCalledWith('/rooms/shop/docs/ROOM.md', { content: '# Room\n\n## Current goal\nship v2' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Saved ROOM.md');
  });

  it('sends any file to an agent you may use', async () => {
    const { api } = await setup();
    const picker = screen.getByLabelText('Send to');
    expect(within(picker).getAllByRole('option').map((o) => o.textContent)).toEqual(['send to @…', '@bob-b']);
    await userEvent.selectOptions(picker, 'builder');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(api.apiPost).toHaveBeenCalledWith('/agents/builder/send', {
      text: sendFilePrompt({ project: 'shop', root: '/data/rooms/shop' }, 'SPEC.md'),
    }));
    expect(sendFilePrompt({ project: 'shop', root: '/r/shop' }, 'SPEC.md')).toContain('/r/shop/SPEC.md');
  });

  it('switching rooms loads that room; a room event for it refreshes the file list', async () => {
    const { api, view } = await setup();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Room' }), 'notes');
    await waitFor(() => expect(api.apiGet).toHaveBeenCalledWith('/rooms/notes/docs'));
    const before = vi.mocked(api.apiGet).mock.calls.filter(([p]) => p === '/rooms/notes/docs').length;
    view.rerender(<RoomView agents={[]} lastEvent={{ id: 9, type: 'room.report_added', entityType: 'room', entityId: 'r', payload: { project: 'notes', path: 'REPORTS/x.md' }, createdAt: '' }} />);
    await waitFor(() => expect(vi.mocked(api.apiGet).mock.calls.filter(([p]) => p === '/rooms/notes/docs').length).toBe(before + 1));
  });
});
