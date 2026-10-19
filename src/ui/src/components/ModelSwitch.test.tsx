// @vitest-environment jsdom

import '../../test-setup';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import ModelSwitch from './ModelSwitch';
import type { Agent } from '../types';

vi.mock('../hooks/useApi', () => ({ apiGet: vi.fn(), apiPost: vi.fn() }));

const AGENT = { id: 'a1', name: 'codex-antonio', runtime: 'codex', status: 'idle', model: null, effort: 'high', alias: null } as unknown as Agent;

describe('ModelSwitch', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const api = await import('../hooks/useApi');
    vi.mocked(api.apiGet).mockResolvedValue({ runtime: 'codex', free_text: false, source: 'codex_cache', models: [
      { id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', efforts: ['high', 'ultra'] },
      { id: 'gpt-6-astra', label: 'GPT-6-Astra', efforts: ['medium', 'high', 'max'] },
    ] } as never);
    vi.mocked(api.apiPost).mockResolvedValue({ agent: { ...AGENT, model: 'gpt-6-astra', effort: 'high' }, applied: 'relaunched', note: 'Codex restarted with the new model and resumed its conversation.' } as never);
  });

  it('lists the CLI models on open, offers the efforts of the chosen model, and applies the pin', async () => {
    const api = await import('../hooks/useApi');
    const onApplied = vi.fn();
    render(<ModelSwitch agent={AGENT} onApplied={onApplied} />);
    fireEvent.click(screen.getByText('MODEL'));
    await waitFor(() => expect(screen.getByLabelText('Model')).toBeInTheDocument());
    expect(vi.mocked(api.apiGet)).toHaveBeenCalledWith('/agents/a1/models');
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'gpt-6-astra' } });
    const effort = screen.getByLabelText('Effort') as HTMLSelectElement;
    expect([...effort.options].map((o) => o.value)).toEqual(['', 'medium', 'high', 'max']);
    fireEvent.change(effort, { target: { value: 'high' } });
    fireEvent.click(screen.getByText('APPLY'));
    await waitFor(() => expect(vi.mocked(api.apiPost)).toHaveBeenCalledWith('/agents/a1/model', { model: 'gpt-6-astra', effort: 'high' }));
    await waitFor(() => expect(onApplied).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-6-astra' }), expect.stringContaining('resumed')));
  });
});
