// @vitest-environment jsdom

import '../../../test-setup';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import BoardRail from './BoardRail';

describe('BoardRail', () => {
  it('shows open tasks, pending reviews and attention badges; a click expands', async () => {
    const onExpand = vi.fn();
    render(<BoardRail openTasks={5} pendingReviews={2} attention={0} onExpand={onExpand} />);
    expect(screen.getByLabelText('Open tasks: 5')).toHaveTextContent('5');
    expect(screen.getByLabelText('Pending reviews: 2')).toHaveTextContent('2');
    expect(screen.getByLabelText('Attention: 0')).toHaveTextContent('0');
    const rail = screen.getByRole('button', { name: 'Expand board' });
    expect(rail.className).toContain('w-10'); // 40px
    await userEvent.click(rail);
    expect(onExpand).toHaveBeenCalledTimes(1);
  });
});
