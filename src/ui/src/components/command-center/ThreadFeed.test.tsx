// @vitest-environment jsdom

import '../../../test-setup';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ThreadFeed from './ThreadFeed';
import type { ThreadItem, User } from '../../types';

const ana: User = { id: 'u-ana', name: 'ana', role: 'developer', color: '#2563eb' };

function item(over: Partial<ThreadItem>): ThreadItem {
  return {
    id: `ev-${over.event_id ?? 1}`, event_id: 1, at: '2026-10-01 10:41:00', kind: 'report', type: 'message.created',
    agent_id: 'a1', actor_id: null, title: 'Report (result)', body: null, refs: {}, needs_attention: false, actions: [], ...over,
  };
}

const ITEMS: ThreadItem[] = [
  item({ event_id: 1, kind: 'prompt', title: 'Prompt sent', body: 'start T1', actor_id: 'u-ana' }),
  item({ event_id: 2, kind: 'request', title: 'Question', body: 'which DB file?', needs_attention: true,
    actions: [{ id: 'reply', label: 'Reply', method: 'POST', path: '/api/messages', body: { to: 'a1' } }] }),
  item({ event_id: 3, kind: 'verdict', title: 'NEEDS FIXES (2 issues)', needs_attention: true,
    actions: [{ id: 'send_fixes', label: 'Send fixes', method: 'POST', path: '/api/ai-reviews/rv/send-fixes' }] }),
  item({ event_id: 4, kind: 'run', title: 'Run finished · exit 0 · RESULT: PASS' }),
];

function renderFeed(over: Partial<Parameters<typeof ThreadFeed>[0]> = {}) {
  const props = {
    items: ITEMS,
    users: new Map([[ana.id, ana]]),
    agentNames: new Map([['a1', 'grok-fe']]),
    attentionOnly: false,
    onToggleAttention: vi.fn(),
    attentionCount: 2,
    focusLabel: 'all',
    onAction: vi.fn(),
    expanded: {},
    terminal: null,
    ...over,
  };
  render(<ThreadFeed {...props} />);
  return props;
}

describe('ThreadFeed', () => {
  it('renders typed items with agent, actor (in their color) and body', () => {
    renderFeed();
    const prompt = within(screen.getByTestId('thread-item-1'));
    expect(prompt.getByText('prompt')).toBeInTheDocument();
    expect(prompt.getByText('grok-fe')).toBeInTheDocument();
    expect(prompt.getByText('start T1')).toBeInTheDocument();
    expect(prompt.getByText('ana').style.color).toBe('rgb(37, 99, 235)');
    expect(screen.getByText('Run finished · exit 0 · RESULT: PASS')).toBeInTheDocument();
  });

  it('attention filter shows only items that need you, with the count', async () => {
    const props = renderFeed({ attentionOnly: true });
    expect(screen.queryByTestId('thread-item-1')).toBeNull();
    expect(screen.getByTestId('thread-item-2')).toBeInTheDocument();
    expect(screen.getByTestId('thread-item-3')).toBeInTheDocument();
    const toggle = screen.getByRole('button', { name: /Attention/ });
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(toggle).toHaveTextContent('●2');
    await userEvent.click(toggle);
    expect(props.onToggleAttention).toHaveBeenCalled();
  });

  it('renders exactly the server actions as buttons and reports clicks', async () => {
    const props = renderFeed();
    expect(within(screen.getByTestId('thread-item-1')).queryByRole('button')).toBeNull();
    await userEvent.click(within(screen.getByTestId('thread-item-3')).getByRole('button', { name: 'Send fixes' }));
    expect(props.onAction).toHaveBeenCalledWith(ITEMS[2], ITEMS[2].actions[0]);
  });

  it('shows GET-action output under its item', () => {
    renderFeed({ expanded: { 'ev-4': 'npm test\n553 passed' } });
    expect(within(screen.getByTestId('thread-item-4')).getByText(/553 passed/)).toBeInTheDocument();
  });

  it('replies render as chat bubbles with quick-reply chips; option lines become chips', async () => {
    const reply = item({
      event_id: 9, kind: 'reply', title: 'Reply', agent_id: 'a1', needs_attention: true,
      body: 'Codex2 finished the email fixes.\nReview them now?\n[ ] Review now\n[ ] Hold',
      actions: [
        { id: 'quick_reply', label: 'Review now', method: 'POST', path: '/api/agents/a1/send', body: { text: 'Review now' } },
        { id: 'quick_reply', label: 'Hold', method: 'POST', path: '/api/agents/a1/send', body: { text: 'Hold' } },
      ],
    });
    const props = renderFeed({ items: [reply] });
    const bubble = within(screen.getByTestId('thread-item-9'));
    expect(bubble.getByText('grok-fe')).toBeInTheDocument();
    expect(bubble.getByText(/Review them now\?/)).toBeInTheDocument();
    expect(bubble.queryByText(/\[ \]/)).toBeNull();
    const chips = within(bubble.getByRole('group', { name: 'Quick replies' })).getAllByRole('button');
    expect(chips.map((c) => c.textContent)).toEqual(['Review now', 'Hold']);
    await userEvent.click(chips[1]);
    expect(props.onAction).toHaveBeenCalledWith(reply, reply.actions[1]);
  });

  it('a seat\'s reply bubble uses its user\'s color (spec §5d)', () => {
    renderFeed({ items: [item({ event_id: 12, kind: 'reply', title: 'Reply', body: 'hi' })], agentColors: new Map([['a1', '#db2777']]) });
    const bubble = screen.getByTestId('thread-item-12').querySelector('div') as HTMLElement;
    expect(bubble.style.borderLeftColor).toBe('rgb(219, 39, 119)');
    expect(within(screen.getByTestId('thread-item-12')).getByText('grok-fe').style.color).toBe('rgb(219, 39, 119)');
  });

  it('reply bubbles show the agent persona', () => {
    renderFeed({ items: [item({ event_id: 11, kind: 'reply', title: 'Reply', body: 'done' })], personas: new Map([['a1', 'frontend lead']]) });
    expect(within(screen.getByTestId('thread-item-11')).getByText('frontend lead')).toBeInTheDocument();
  });

  it('a partial (10-minute) reply says so', () => {
    renderFeed({ items: [item({ event_id: 10, kind: 'reply', title: 'Reply (partial — no idle after 10 min)', body: 'so far…' })] });
    expect(screen.getByText('(partial — no idle after 10 min)')).toBeInTheDocument();
  });

  it('the terminal tail is folded until opened', async () => {
    const onToggle = vi.fn();
    const { rerender } = render(<div />);
    rerender(<ThreadFeed {...{
      items: [], users: new Map(), agentNames: new Map(), attentionOnly: false, onToggleAttention: vi.fn(),
      attentionCount: 0, focusLabel: 'grok-fe', onAction: vi.fn(), expanded: {},
      terminal: { open: false, output: null, onToggle },
    }} />);
    expect(screen.queryByTestId('terminal-tail')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /terminal tail/ }));
    expect(onToggle).toHaveBeenCalled();
    rerender(<ThreadFeed {...{
      items: [], users: new Map(), agentNames: new Map(), attentionOnly: false, onToggleAttention: vi.fn(),
      attentionCount: 0, focusLabel: 'grok-fe', onAction: vi.fn(), expanded: {},
      terminal: { open: true, output: '$ npm test\n✓ 14 passed', onToggle },
    }} />);
    expect(screen.getByTestId('terminal-tail')).toHaveTextContent('✓ 14 passed');
    expect(screen.getByText('No activity yet.')).toBeInTheDocument();
  });
});
