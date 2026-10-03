// @vitest-environment jsdom

import '../../test-setup';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import FileView from './FileView';

vi.mock('../hooks/useApi', () => ({ apiGet: vi.fn() }));

describe('FileView', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders a markdown file from /files/view with its name, path and size', async () => {
    const useApi = await import('../hooks/useApi');
    vi.mocked(useApi.apiGet).mockResolvedValue({
      path: '/home/ci/inbox/p.md', name: 'p.md', size: 2048, modified_at: '2026-10-03T08:00:00Z', kind: 'markdown', content: '# Proposal\n\nthree codes',
    } as never);
    render(
      <MemoryRouter initialEntries={['/file?path=%2Fhome%2Fci%2Finbox%2Fp.md']}>
        <Routes><Route path="/file" element={<FileView />} /></Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'p.md' })).toBeInTheDocument();
    expect(useApi.apiGet).toHaveBeenCalledWith('/files/view?path=%2Fhome%2Fci%2Finbox%2Fp.md');
    expect(screen.getByTestId('file-markdown')).toHaveTextContent('three codes');
    expect(screen.getByText('/home/ci/inbox/p.md')).toBeInTheDocument();
    expect(screen.getByText(/2\.0 KB/)).toBeInTheDocument();
  });

  it('shows the server error for a path outside the browsable roots', async () => {
    const useApi = await import('../hooks/useApi');
    vi.mocked(useApi.apiGet).mockRejectedValue(new Error('Not a browsable location (rooms, worktrees, …)'));
    render(
      <MemoryRouter initialEntries={['/file?path=%2Fetc%2Fshadow']}>
        <Routes><Route path="/file" element={<FileView />} /></Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('Not a browsable location');
  });
});
