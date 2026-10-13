import { describe, expect, it } from 'vitest';
import { deriveDeployState, unknownReason, type DeriveFacts } from './deploy-state.js';

function facts(over: Partial<DeriveFacts> = {}): DeriveFacts {
  return {
    superseded: false,
    mergedToMain: false,
    containedInStaging: false,
    containedInProd: false,
    behindMain: false,
    verdict: 'pass',
    quick: 'green',
    full: 'green',
    readyForProd: false,
    ...over,
  };
}

describe('deriveDeployState', () => {
  it('a newer freeze in the same lane is superseded', () => {
    expect(deriveDeployState(facts({ superseded: true, containedInStaging: true, containedInProd: true }))).toBe('superseded');
  });

  it('a SHA contained in staging, and not in prod, waits for Ready for prod', () => {
    expect(deriveDeployState(facts({ containedInStaging: true }))).toBe('on_staging');
    expect(deriveDeployState(facts({ containedInStaging: true, readyForProd: true }))).toBe('awaiting_prod_go');
  });

  it('behind main stays actionable, and a superseded card is history', () => {
    expect(deriveDeployState(facts({
      behindMain: true,
      containedInStaging: null,
      containedInProd: null,
      mergedToMain: null,
    }))).toBe('unknown');
    expect(deriveDeployState(facts({
      behindMain: true,
      verdict: null,
      quick: 'missing',
      full: 'missing',
    }))).toBe('awaiting_review');
    expect(deriveDeployState(facts({ superseded: true, behindMain: true }))).toBe('superseded');
  });

  it('an unknown staging or prod tip is unknown, never ready to stage', () => {
    const unknown = facts({ containedInStaging: null, containedInProd: null });
    expect(deriveDeployState(unknown)).toBe('unknown');
    expect(unknownReason(unknown)).toMatch(/tip is unknown/);
    expect(deriveDeployState(facts({ containedInProd: null }))).toBe('unknown');
    expect(deriveDeployState(facts({ quick: 'unknown' }))).toBe('unknown');
  });

  it('review and tests decide only after deploy location is known', () => {
    expect(deriveDeployState(facts({ verdict: null, quick: 'missing', full: 'missing' }))).toBe('awaiting_review');
    expect(deriveDeployState(facts({ verdict: 'needs-fixes' }))).toBe('needs_fixes');
    expect(deriveDeployState(facts({ quick: 'pending', full: 'missing' }))).toBe('awaiting_tests');
    expect(deriveDeployState(facts({ quick: 'red', full: 'green' }))).toBe('needs_fixes');
    expect(deriveDeployState(facts({ quick: 'green', full: 'missing' }))).toBe('ready_to_stage');
    expect(deriveDeployState(facts())).toBe('ready_to_stage');
    expect(deriveDeployState(facts({ containedInProd: true, behindMain: true }))).toBe('live_on_prod');
  });
});
