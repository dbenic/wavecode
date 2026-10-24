import { afterEach, describe, expect, it, vi } from 'vitest';
import { opsStageBlockFromChecks, opsStageRefusal } from './ops-stage.js';
import { STAGE_NEEDS_PASS } from './releases.js';
import { needsGreenQuick, QUICK_CHECK_RUNNING } from './lane-status.js';

describe('opsStageBlockFromChecks', () => {
  const sha = 'a'.repeat(40);

  it('requires a green quick check, then a PASS, then the stored forward check', () => {
    expect(opsStageBlockFromChecks({ sha, quick: 'pending', verdict: 'pass', stageBlock: null })).toBe(QUICK_CHECK_RUNNING);
    expect(opsStageBlockFromChecks({ sha, quick: 'red', verdict: 'pass', stageBlock: null })).toBe(needsGreenQuick(sha.slice(0, 8)));
    expect(opsStageBlockFromChecks({ sha, quick: 'missing', verdict: 'pass', stageBlock: null })).toBe(needsGreenQuick(sha.slice(0, 8)));
    expect(opsStageBlockFromChecks({ sha, quick: 'green', verdict: 'needs-fixes', stageBlock: null })).toBe(STAGE_NEEDS_PASS);
    expect(opsStageBlockFromChecks({
      sha, quick: 'green', verdict: 'pass', stageBlock: 'would roll staging back',
    })).toBe('would roll staging back');
    expect(opsStageBlockFromChecks({ sha, quick: 'green', verdict: 'pass', stageBlock: null, behindMain: true }))
      .toMatch(/behind main/);
    expect(opsStageBlockFromChecks({ sha, quick: 'green', verdict: 'pass', stageBlock: null })).toBeNull();
  });
});

describe('opsStageRefusal', () => {
  const sha = 'b'.repeat(40);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('asks resolveStagingTip and refuses when the SHA is already the tip', async () => {
    const freezes = await import('./release-freezes.js');
    const releases = await import('./releases.js');
    const forward = await import('./staging-forward.js');
    vi.spyOn(freezes, 'getFreeze').mockReturnValue({
      sha, project: 'demo', lane: 'lane', verdict: 'pass', gate: null, freeze_path: null,
    } as never);
    vi.spyOn(freezes, 'viewShaChecks').mockResolvedValue({ quick: 'green', full: 'missing', gate: null });
    const tip = vi.spyOn(releases, 'resolveStagingTip').mockResolvedValue({
      state: 'local', source: 'local', tip: { sha, version: '1.0.0', lane: null },
    });
    vi.spyOn(forward, 'evaluateForward').mockResolvedValue({ ok: true, rollback: false, reason: null });
    await expect(opsStageRefusal(sha)).resolves.toMatch(/already on staging/);
    expect(tip).toHaveBeenCalledWith('demo', { fresh: true });
  });

  it('returns the forward-only refusal', async () => {
    const freezes = await import('./release-freezes.js');
    const releases = await import('./releases.js');
    const forward = await import('./staging-forward.js');
    vi.spyOn(freezes, 'getFreeze').mockReturnValue({
      sha, project: 'demo', lane: 'lane', verdict: 'pass', gate: null, freeze_path: null,
    } as never);
    vi.spyOn(freezes, 'viewShaChecks').mockResolvedValue({ quick: 'green', full: 'missing', gate: null });
    vi.spyOn(releases, 'resolveStagingTip').mockResolvedValue({
      state: 'local', source: 'local', tip: { sha: 'c'.repeat(40), version: '1.0.0', lane: null },
    });
    vi.spyOn(forward, 'evaluateForward').mockResolvedValue({ ok: false, error: 'would roll staging back: missing 2' });
    await expect(opsStageRefusal(sha)).resolves.toBe('would roll staging back: missing 2');
  });
});
