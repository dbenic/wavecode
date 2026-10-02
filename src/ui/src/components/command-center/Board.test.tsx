// @vitest-environment jsdom

import '../../../test-setup';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import Board from './Board';
import { TASK_DRAG_TYPE } from './Roster';
import type { Task, User } from '../../types';

const ana: User = { id: 'u-ana', name: 'ana', role: 'developer', color: '#2563eb' };
const recent = new Date().toISOString();

function task(over: Partial<Task>): Task {
  return { id: 't', agent_id: null, prompt: 'p', status: 'pending', priority: 0, created_at: recent, ...over };
}

describe('Board', () => {
  it('shows swimlanes by owner and the review count', () => {
    render(<Board
      tasks={[
        task({ id: '1', prompt: 'T1 identity', status: 'done', created_by: 'u-ana' }),
        task({ id: '2', prompt: 'T2 leases', status: 'running', created_by: 'u-ana', dependencies: ['1'] }),
        task({ id: '3', prompt: 'nightly', created_by: null }),
        task({ id: '4', prompt: 'ancient', status: 'done', created_by: null, created_at: '2020-01-01T00:00:00Z' }),
      ]}
      users={new Map([[ana.id, ana]])}
      reviewCount={2}
      canAssign
    />);
    expect(screen.getByText('reviews: 2')).toBeInTheDocument();
    const lane = within(screen.getByLabelText('Lane ana'));
    expect(lane.getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      expect.stringContaining('T2 leases'),
      expect.stringContaining('T1 identity'),
    ]);
    expect(lane.getByTitle('Depends on')).toHaveTextContent('↳1');
    expect(within(screen.getByLabelText('Lane System')).queryByText('ancient')).toBeNull(); // old done work hidden
  });

  it('shows the per-template metrics strip (spec §5f)', () => {
    render(<Board tasks={[]} users={new Map()} reviewCount={0} canAssign metrics={{ room: 'shop', templates: [
      { template: 'build', tasks: 2, reviewed: 2, first_pass_rate: 0.5, mean_fix_rounds: 0.5, questions_rate: 0.5, mean_time_to_result_s: 720 },
      { template: 'verify', tasks: 0, reviewed: 0, first_pass_rate: null, mean_fix_rounds: null, questions_rate: null, mean_time_to_result_s: null },
    ] }} />);
    expect(screen.getByTestId('metrics-build')).toHaveTextContent('build50% first pass0.5 fixes0.5 q/task12m to RESULT');
    expect(screen.queryByTestId('metrics-verify')).toBeNull();
    expect(screen.getByLabelText('Template metrics')).toHaveTextContent('shop · templates');
  });

  it('pending tasks are draggable with the task id; running ones are not; observers cannot drag', () => {
    const { rerender } = render(<Board tasks={[task({ id: 'p1', prompt: 'todo' }), task({ id: 'r1', prompt: 'busy', status: 'running' })]} users={new Map()} reviewCount={0} canAssign />);
    const pending = screen.getByText('todo').closest('li')!;
    expect(pending).toHaveAttribute('draggable', 'true');
    expect(screen.getByText('busy').closest('li')).toHaveAttribute('draggable', 'false');
    const setData = vi.fn();
    fireEvent.dragStart(pending, { dataTransfer: { setData, effectAllowed: '' } });
    expect(setData).toHaveBeenCalledWith(TASK_DRAG_TYPE, 'p1');

    rerender(<Board tasks={[task({ id: 'p1', prompt: 'todo' })]} users={new Map()} reviewCount={0} canAssign={false} />);
    expect(screen.getByText('todo').closest('li')).toHaveAttribute('draggable', 'false');
  });
});
