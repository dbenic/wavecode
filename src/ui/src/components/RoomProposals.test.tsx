// @vitest-environment jsdom

import '../../test-setup';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import RoomProposals from './RoomProposals';

vi.mock('../hooks/useApi', () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(async () => ({ status: 'approved' })),
}));

const PROPOSAL = {
  id: 'p1', room: 'shop', path: 'TEMPLATES/build.md', status: 'pending', proposed_by: 'u-ana', created_at: '2026-10-02 03:05',
  evidence: '4/6 builds failed typecheck on first review → add npm run typecheck to build done_when',
  diff: '  # Build\n- old line\n+ - run `npm run typecheck`',
};

describe('RoomProposals (spec §5f)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists pending proposals with evidence and a coloured diff; promote applies, reject drops', async () => {
    const api = await import('../hooks/useApi');
    vi.mocked(api.apiGet).mockResolvedValue([PROPOSAL] as never);
    render(<RoomProposals />);
    const card = within(await screen.findByTestId('proposal-p1'));
    expect(card.getByText('TEMPLATES/build.md')).toBeInTheDocument();
    expect(card.getByText(/4\/6 builds failed typecheck/)).toBeInTheDocument();
    expect(card.getByText('+ - run `npm run typecheck`').className).toContain('text-emerald-400');
    expect(card.getByText('- old line').className).toContain('text-red-400');

    await userEvent.click(card.getByRole('button', { name: 'Promote' }));
    await waitFor(() => expect(api.apiPost).toHaveBeenCalledWith('/proposals/p1/promote'));
    await userEvent.click(card.getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(api.apiPost).toHaveBeenCalledWith('/proposals/p1/reject'));
  });

  it('shows the server\'s refusal (e.g. stale or not the owner)', async () => {
    const api = await import('../hooks/useApi');
    vi.mocked(api.apiGet).mockResolvedValue([PROPOSAL] as never);
    vi.mocked(api.apiPost).mockRejectedValueOnce(new Error('TEMPLATES/build.md changed since this proposal was made — it is stale'));
    render(<RoomProposals />);
    await userEvent.click(await screen.findByRole('button', { name: 'Promote' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('stale');
  });

  it('renders nothing when there are no proposals', async () => {
    const api = await import('../hooks/useApi');
    vi.mocked(api.apiGet).mockResolvedValue([] as never);
    const { container } = render(<RoomProposals />);
    await waitFor(() => expect(api.apiGet).toHaveBeenCalledWith('/proposals?status=pending'));
    expect(container).toBeEmptyDOMElement();
  });
});
