// @vitest-environment jsdom

import '../../../test-setup';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within, cleanup } from '@testing-library/react';
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

  it('paths in a report or verdict body are viewer links; markup in the body is escaped', async () => {
    const onNavigate = vi.fn();
    renderFeed({
      onNavigate,
      items: [item({ kind: 'verdict', title: 'Release freeze wavepulse @ 8926dde2: PASS', body: 'lane wc-x · reviewed by @codex2 · /home/wave/inbox/codex2-verdict-peppol-8926dde23-20261010.md <b>not bold</b>' })],
    });
    const link = screen.getByRole('link', { name: '/home/wave/inbox/codex2-verdict-peppol-8926dde23-20261010.md' });
    expect(link.getAttribute('href')).toBe(`/file?path=${encodeURIComponent('/home/wave/inbox/codex2-verdict-peppol-8926dde23-20261010.md')}`);
    expect(document.querySelector('b')).toBeNull();
    await userEvent.click(link);
    expect(onNavigate).toHaveBeenCalledWith(`/file?path=${encodeURIComponent('/home/wave/inbox/codex2-verdict-peppol-8926dde23-20261010.md')}`);
  });

  it('shows an "answering…" indicator under an unanswered prompt until its reply arrives', () => {
    const justNow = new Date(Date.now() - 5000).toISOString().replace('T', ' ').slice(0, 19);
    const prompt = item({ event_id: 20, kind: 'prompt', title: 'Prompt sent', agent_id: 'pm', body: 'what is @fable doing?', at: justNow });
    renderFeed({ items: [prompt], agentNames: new Map([['pm', 'pm']]) });
    expect(screen.getByRole('status', { name: /pm is answering/ })).toBeInTheDocument();
    cleanup();

    const reply = item({ event_id: 21, kind: 'reply', title: 'Reply', agent_id: 'pm', body: 'Fable deployed 0.440.47.', refs: { prompt_event_id: 20 }, at: justNow });
    renderFeed({ items: [prompt, reply], agentNames: new Map([['pm', 'pm']]) });
    expect(screen.queryByRole('status', { name: /pm is answering/ })).toBeNull();
    expect(screen.getByText('Fable deployed 0.440.47.')).toBeInTheDocument();
  });

  it('does not show the indicator for a prompt older than the 10-minute fallback window', () => {
    const old = item({ event_id: 30, kind: 'prompt', title: 'Prompt sent', agent_id: 'pm', at: '2026-01-01 10:00:00' });
    renderFeed({ items: [old], agentNames: new Map([['pm', 'pm']]) });
    expect(screen.queryByRole('status', { name: /answering/ })).toBeNull();
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

  it('a file path in a reply is an in-app link to the viewer; clicking it navigates instead of reloading', async () => {
    const onNavigate = vi.fn();
    const reply = item({ event_id: 40, kind: 'reply', title: 'Reply', body: 'Proposal: /home/ci/inbox/codex1-three-codes-20261003.md — review it.' });
    renderFeed({ items: [reply], onNavigate });
    const link = within(screen.getByTestId('thread-item-40')).getByRole('link', { name: '/home/ci/inbox/codex1-three-codes-20261003.md' });
    expect(link).toHaveAttribute('href', '/file?path=%2Fhome%2Fci%2Finbox%2Fcodex1-three-codes-20261003.md');
    expect(link).not.toHaveAttribute('target');
    await userEvent.click(link);
    expect(onNavigate).toHaveBeenCalledWith('/file?path=%2Fhome%2Fci%2Finbox%2Fcodex1-three-codes-20261003.md');
  });

  it('a seat\'s reply bubble uses its user\'s color (spec §5d)', () => {
    renderFeed({ items: [item({ event_id: 12, kind: 'reply', title: 'Reply', body: 'hi' })], agentColors: new Map([['a1', '#db2777']]) });
    const bubble = screen.getByTestId('thread-item-12').querySelector('div') as HTMLElement;
    expect(bubble.style.borderLeftColor).toBe('rgb(219, 39, 119)');
    expect(within(screen.getByTestId('thread-item-12')).getByText('grok-fe').style.color).toBe('rgb(219, 39, 119)');
  });

  it('replies take 👍 / 👎 with an optional "better: …" note (spec §5f)', async () => {
    const reply = item({
      event_id: 30, kind: 'reply', title: 'Reply', body: 'a long inventory', refs: { message_id: 'm1' },
      feedback: { up: 2, down: 0, mine: null, mine_note: null, can_vote: true },
    });
    const onFeedback = vi.fn();
    renderFeed({ items: [reply], onFeedback });
    const bubble = within(screen.getByTestId('thread-item-30'));
    expect(bubble.getByRole('button', { name: 'Helpful' })).toHaveTextContent('👍 2');
    await userEvent.click(bubble.getByRole('button', { name: 'Helpful' }));
    expect(onFeedback).toHaveBeenLastCalledWith(reply, 1);

    await userEvent.click(bubble.getByRole('button', { name: 'Not helpful' }));
    await userEvent.type(bubble.getByLabelText('Better:'), 'too long');
    await userEvent.click(bubble.getByRole('button', { name: 'Send' }));
    expect(onFeedback).toHaveBeenLastCalledWith(reply, -1, 'too long');
  });

  it('shows my vote and note; no voting for observers', () => {
    renderFeed({ items: [
      item({ event_id: 31, kind: 'reply', title: 'Reply', body: 'x', feedback: { up: 0, down: 1, mine: -1, mine_note: 'too long', can_vote: true } }),
      item({ event_id: 32, kind: 'reply', title: 'Reply', body: 'y', feedback: { up: 0, down: 0, mine: null, mine_note: null, can_vote: false } }),
    ], onFeedback: vi.fn() });
    const mine = within(screen.getByTestId('thread-item-31'));
    expect(mine.getByRole('button', { name: 'Not helpful' })).toHaveAttribute('aria-pressed', 'true');
    expect(mine.getByText('“too long”')).toBeInTheDocument();
    expect(within(screen.getByTestId('thread-item-32')).queryByRole('button', { name: 'Helpful' })).toBeNull();
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
