// @vitest-environment jsdom

import '../../../test-setup';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Composer, { type ComposerSend } from './Composer';
import type { Agent } from '../../types';
import type { ComposerMode } from '../../utils/command-center';

function agent(over: Partial<Agent>): Agent {
  return {
    id: over.name!, name: 'x', runtime: 'grok', tmux_session: 'wc', workspace: null,
    mode: 'spawned', status: 'idle', model: null, effort: null, created_at: '', can_act: true, ...over,
  };
}

const AGENTS = [
  agent({ name: 'grok-fe' }),
  agent({ name: 'opus-fe', owner: 'bob', can_act: false }),
  agent({ name: 'pinned', model: 'opus' }),
  agent({ name: 'pm', orchestrator: true }),
];

function Harness(props: { onSend: (s: ComposerSend) => Promise<true | string>; initialTarget?: string; initialMode?: ComposerMode; replyTaskId?: string | null }) {
  const [target, setTarget] = useState(props.initialTarget ?? 'grok-fe');
  const [mode, setMode] = useState<ComposerMode>(props.initialMode ?? 'prompt');
  return (
    <Composer
      agents={AGENTS}
      target={target}
      onTargetChange={setTarget}
      mode={mode}
      onModeChange={setMode}
      replyTaskId={props.replyTaskId ?? null}
      onSend={props.onSend}
    />
  );
}

describe('Composer', () => {
  it('Prompt mode: Enter sends to the target agent and clears the box', async () => {
    const onSend = vi.fn(async () => true as const);
    render(<Harness onSend={onSend} />);
    const box = screen.getByRole('textbox', { name: 'Message' });
    await userEvent.type(box, 'start T1{Enter}');
    expect(onSend).toHaveBeenCalledWith({ kind: 'prompt', agentId: 'grok-fe', text: 'start T1' });
    expect(box).toHaveValue('');
  });

  it('Shift+Enter makes a newline instead of sending', async () => {
    const onSend = vi.fn(async () => true as const);
    render(<Harness onSend={onSend} />);
    await userEvent.type(screen.getByRole('textbox', { name: 'Message' }), 'a{Shift>}{Enter}{/Shift}b');
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('a\nb');
  });

  it('Task mode: @all = unassigned; model/effort pin offered when the agent has none', async () => {
    const onSend = vi.fn(async () => true as const);
    render(<Harness onSend={onSend} />);
    await userEvent.click(screen.getByRole('radio', { name: 'Task' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Model' }), 'grok-4.6');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Effort' }), 'high');
    await userEvent.type(screen.getByRole('textbox', { name: 'Message' }), 'build the board{Enter}');
    expect(onSend).toHaveBeenLastCalledWith({ kind: 'task', agentId: 'grok-fe', prompt: 'build the board', model: 'grok-4.6', effort: 'high' });

    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Target' }), '');
    await userEvent.clear(screen.getByRole('textbox', { name: 'Model' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Message' }), 'anyone{Enter}');
    expect(onSend).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'task', agentId: null, prompt: 'anyone' }));

    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Target' }), 'pinned');
    expect(screen.queryByRole('textbox', { name: 'Model' })).toBeNull();
  });

  it('Reply mode carries the task reference', async () => {
    const onSend = vi.fn(async () => true as const);
    render(<Harness onSend={onSend} initialMode="reply" replyTaskId="task-123456" />);
    expect(screen.getByText('re: task 123456')).toBeInTheDocument();
    await userEvent.type(screen.getByRole('textbox', { name: 'Message' }), 'use wavecode.db{Enter}');
    expect(onSend).toHaveBeenCalledWith({ kind: 'reply', agentId: 'grok-fe', text: 'use wavecode.db', refTaskId: 'task-123456' });
  });

  it('File mode sends the chosen file', async () => {
    const onSend = vi.fn(async () => true as const);
    render(<Harness onSend={onSend} initialMode="file" />);
    const file = new File(['png'], 'mock.png', { type: 'image/png' });
    await userEvent.upload(screen.getByLabelText('File'), file);
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSend).toHaveBeenCalledWith({ kind: 'file', agentId: 'grok-fe', file });
  });

  it('slash commands become actions; bad ones explain themselves', async () => {
    const onSend = vi.fn(async () => true as const);
    render(<Harness onSend={onSend} />);
    const box = screen.getByRole('textbox', { name: 'Message' });
    await userEvent.type(box, '/reserve 2h{Enter}');
    expect(onSend).toHaveBeenLastCalledWith({ kind: 'slash', agentId: 'grok-fe', command: { cmd: 'reserve', hours: 2 } });
    await userEvent.type(box, '/promote{Enter}');
    expect(onSend).toHaveBeenLastCalledWith({ kind: 'slash', agentId: 'grok-fe', command: { cmd: 'promote' } });
    await userEvent.type(box, '/deploy{Enter}');
    expect(screen.getByRole('alert')).toHaveTextContent('Unknown command /deploy');
    expect(onSend).toHaveBeenCalledTimes(2);
  });

  it('Ask is the default mode name; the seat is marked in the target chip', () => {
    render(<Harness onSend={vi.fn()} initialTarget="pm" />);
    expect(screen.getByRole('radio', { name: 'Ask' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByRole('radio', { name: 'Prompt' })).toBeNull();
    expect(screen.getByRole('combobox', { name: 'Target' })).toHaveDisplayValue('@pm · seat');
  });

  it('@name in the text retargets the send and the chip', async () => {
    const onSend = vi.fn(async () => true as const);
    render(<Harness onSend={onSend} initialTarget="pm" />);
    await userEvent.type(screen.getByRole('textbox', { name: 'Message' }), '@grok-fe what are you on?{Enter}');
    expect(onSend).toHaveBeenCalledWith({ kind: 'prompt', agentId: 'grok-fe', text: 'what are you on?' });
    expect(screen.getByRole('combobox', { name: 'Target' })).toHaveValue('grok-fe');
  });

  it('@name to an agent you may not use is refused before sending', async () => {
    const onSend = vi.fn(async () => true as const);
    render(<Harness onSend={onSend} initialTarget="pm" />);
    await userEvent.type(screen.getByRole('textbox', { name: 'Message' }), '@opus-fe hi{Enter}');
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('opus-fe is owned by bob');
  });

  it('shows the owner lock and disables sending to an agent you may not use', () => {
    render(<Harness onSend={vi.fn()} initialTarget="opus-fe" />);
    expect(screen.getByRole('note')).toHaveTextContent('opus-fe is owned by bob');
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('prompt mode needs an agent; server errors are shown and the text is kept', async () => {
    const onSend = vi.fn(async () => 'Agent grok-fe is owned by ana');
    render(<Harness onSend={onSend} initialTarget="" />);
    const box = screen.getByRole('textbox', { name: 'Message' });
    await userEvent.type(box, 'hi{Enter}');
    expect(screen.getByRole('alert')).toHaveTextContent('Pick an agent');
    expect(onSend).not.toHaveBeenCalled();

    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Target' }), 'grok-fe');
    await userEvent.type(box, '{Enter}');
    expect(screen.getByRole('alert')).toHaveTextContent('Agent grok-fe is owned by ana');
    expect(box).toHaveValue('hi');
  });
});
