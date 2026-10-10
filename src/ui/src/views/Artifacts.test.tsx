// @vitest-environment jsdom

import '../../test-setup';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Artifacts from './Artifacts';
import type { Artifact } from '../types';

vi.mock('../hooks/useApi', () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(async () => ({})),
  apiPatch: vi.fn(async (_p: string, body: Record<string, unknown>) => ({ ...FIXTURE, id: 'a-tmp', kind: 'fixture', ...body })),
  apiDelete: vi.fn(async () => ({})),
  apiUpload: vi.fn(async () => ({})),
}));
vi.mock('../hooks/useSSE', () => ({ useSSE: vi.fn() }));

const FIXTURE: Artifact = {
  id: 'a-fix', filename: 'desk91-credit-note.xml', mime_type: 'text/xml', sha256: 'abcdef1234567890', size_bytes: 2048,
  storage_path: '/store/abcdef12/desk91-credit-note.xml', preview_path: null, source_agent_id: null, source_run_id: null,
  note: null, kind: 'fixture', desk: '91', room: 'wavepulse', provenance: 'redacted export of Desk #91 attachment by fable', uploaded_by: 'u1',
  created_at: '2026-10-10 08:00:00',
};
const TRANSIENT: Artifact = { ...FIXTURE, id: 'a-tmp', filename: 'screenshot.png', mime_type: 'image/png', kind: 'transient', desk: null, room: null, provenance: null };

describe('Artifacts (the library)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const api = await import('../hooks/useApi');
    vi.mocked(api.apiGet).mockImplementation(async (p: string) => {
      if (p.startsWith('/artifacts')) return p.includes('kind=fixture') ? [FIXTURE] : [FIXTURE, TRANSIENT];
      if (p === '/agents') return [];
      if (p === '/rooms') return [{ project: 'wavepulse' }];
      if (p === '/peers') return [{ name: 'deploy', url: 'http://deploy' }];
      if (p.startsWith('/peers/deploy/artifacts')) return [{ id: 'r1', filename: 'desk43-bank.csv', mime_type: 'text/csv', size_bytes: 300, sha256: 'zz', desk: '43', room: 'wavepulse', provenance: 'redacted by fable', note: null, created_at: '' }];
      return [];
    });
  });

  it('opens on the Fixtures view with the library fields on each card, and asks the server for fixtures only', async () => {
    const api = await import('../hooks/useApi');
    render(<MemoryRouter><Artifacts /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('desk91-credit-note.xml')).toBeTruthy());
    expect(vi.mocked(api.apiGet)).toHaveBeenCalledWith('/artifacts?kind=fixture');
    expect(screen.getByText('FIXTURE')).toBeTruthy();
    expect(screen.getByText('desk #91')).toBeTruthy();
    expect(screen.getByText('wavepulse', { selector: 'span' })).toBeTruthy();
    expect(screen.getByText(/redacted export of Desk #91/)).toBeTruthy();
    expect(screen.queryByText('screenshot.png')).toBeNull();
  });

  it('ALL shows transient files with a KEEP action that promotes them to fixtures', async () => {
    const api = await import('../hooks/useApi');
    render(<MemoryRouter><Artifacts /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('desk91-credit-note.xml')).toBeTruthy());
    fireEvent.click(screen.getByText('ALL'));
    await waitFor(() => expect(screen.getByText('screenshot.png')).toBeTruthy());
    fireEvent.click(screen.getByText('KEEP'));
    await waitFor(() => expect(vi.mocked(api.apiPatch)).toHaveBeenCalledWith('/artifacts/a-tmp', { kind: 'fixture' }));
  });

  it('DOCUMENTS asks the server for archived documents', async () => {
    const api = await import('../hooks/useApi');
    render(<MemoryRouter><Artifacts /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('desk91-credit-note.xml')).toBeTruthy());
    fireEvent.click(screen.getByText('DOCUMENTS'));
    await waitFor(() => expect(vi.mocked(api.apiGet)).toHaveBeenCalledWith('/artifacts?kind=document'));
  });

  it('search is sent to the server as q', async () => {
    const api = await import('../hooks/useApi');
    render(<MemoryRouter><Artifacts /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('desk91-credit-note.xml')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'PD-108' } });
    await waitFor(() => expect(vi.mocked(api.apiGet)).toHaveBeenCalledWith('/artifacts?kind=fixture&q=PD-108'));
  });

  it('import from a peer lists the peer\'s fixtures and imports one', async () => {
    const api = await import('../hooks/useApi');
    render(<MemoryRouter><Artifacts /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId('peer-import')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Peer'), { target: { value: 'deploy' } });
    await waitFor(() => expect(screen.getByText('desk43-bank.csv')).toBeTruthy());
    fireEvent.click(screen.getByText('IMPORT'));
    await waitFor(() => expect(vi.mocked(api.apiPost)).toHaveBeenCalledWith('/peers/deploy/artifacts/r1/import', {}));
  });

  it('uploads carry the library fields when "keep as fixture" is on', async () => {
    const api = await import('../hooks/useApi');
    render(<MemoryRouter><Artifacts /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('desk91-credit-note.xml')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Desk'), { target: { value: 'PD-108' } });
    fireEvent.change(screen.getByLabelText('Provenance'), { target: { value: 'synthetic sample' } });
    const input = document.querySelector('input[type=file]') as HTMLInputElement;
    const file = new File(['<x/>'], 'pd108-sample.xml', { type: 'text/xml' });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(vi.mocked(api.apiUpload)).toHaveBeenCalled());
    const form = vi.mocked(api.apiUpload).mock.calls[0][1] as FormData;
    expect(form.get('kind')).toBe('fixture');
    expect(form.get('desk')).toBe('PD-108');
    expect(form.get('provenance')).toBe('synthetic sample');
    expect((form.get('file') as File).name).toBe('pd108-sample.xml');
  });
});
