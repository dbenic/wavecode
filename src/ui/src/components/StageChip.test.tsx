// @vitest-environment jsdom

import '../../test-setup';
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import StageChip, { resetStageChipSessionForTest, type StageProgress } from './StageChip';

const SHA = 'abc123abc123abc123abc123abc123abc123abcd';
const PIN = '2026-10-12T18:00:00Z';

function view(over: Partial<StageProgress> = {}): StageProgress {
  return { sha: SHA, status: 'sent', phase: 'build', progress: 'start', version: null, pinUntil: null, url: null, error: null, rollbackStatus: null, ...over };
}

describe('StageChip', () => {
  beforeEach(() => resetStageChipSessionForTest());

  it('pulses the live phase and marks earlier phases done', () => {
    render(<StageChip progress={view({ phase: 'checkout', progress: 'start' })} />);
    expect(screen.getByTestId('phase-build').textContent).toBe('checkout');
    expect(screen.getByTestId('phase-build').className).toMatch(/animate-pulse/);
    expect(screen.getByTestId('phase-fetch').className).toMatch(/emerald/);
    expect(screen.getByTestId('phase-verify').className).toMatch(/slate/);
    expect(screen.queryByTestId('staging-toast')).toBeNull();
  });

  it('confirms a deploy with the short SHA, version, link and local pin time', () => {
    const pin = new Date(PIN).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const { rerender } = render(<StageChip releaseId="rel-1" progress={view()} />);
    rerender(<StageChip releaseId="rel-1" progress={view({
      status: 'deployed', phase: 'done', progress: 'ok', version: '1.2.3', pinUntil: PIN, url: 'https://staging.example/app',
    })} />);
    const chip = screen.getByTestId('stage-chip');
    expect(chip.textContent).toContain('On staging: abc123abc v1.2.3');
    expect(chip.textContent).toContain(`pinned until ${pin}`);
    expect(within(chip).getByRole('link', { name: 'Open staging' }).getAttribute('href')).toBe('https://staging.example/app');
    expect(screen.getByTestId('staging-success').querySelector('.animate-ping')).toBeTruthy();
    const toast = screen.getByTestId('staging-toast');
    expect(toast.textContent).toContain('On staging: abc123abc v1.2.3');
    expect(toast.textContent).toContain('Open staging');
    expect(toast.textContent).toContain(`pinned until ${pin}`);
  });

  it('does not toast when the page opens on a deploy that is already done', () => {
    render(<StageChip releaseId="rel-2" progress={view({ status: 'deployed', version: '1.2.3', url: 'javascript:alert(1)' })} />);
    expect(screen.getByTestId('stage-chip').textContent).toContain('On staging: abc123abc v1.2.3');
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByTestId('staging-toast')).toBeNull();
  });

  it('shows the failed phase, the error and the rollback', () => {
    render(<StageChip progress={view({
      status: 'failed', phase: 'build', progress: 'fail', error: 'BUILD: build failed in fixture', rollbackStatus: 'ok',
    })} />);
    const chip = screen.getByTestId('stage-chip');
    expect(chip.className).toMatch(/red/);
    expect(chip.textContent).toContain('Failed at build');
    expect(chip.textContent).toContain('BUILD: build failed in fixture');
    expect(chip.textContent).toContain('rollback ok');
  });
});
