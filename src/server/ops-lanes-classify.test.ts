import { describe, expect, it } from 'vitest';
import { parseHeartbeat, unreadLane } from './ops-lanes-classify.js';
import { DEFAULT_OPS_BOTS, DEFAULT_OPS_DIR, resolveOpsLanes } from './ops-lanes-config.js';

const NOW = Date.parse('2026-10-24T20:00:00.000Z');
const STALE_S = 120;

function heartbeat(fields: Record<string, unknown>): string {
  return JSON.stringify({
    bot: 'pilot',
    key_status: 'ok',
    heartbeat_at: '2026-10-24T19:59:30.000Z',
    ...fields,
  });
}

describe('ops lane parsing', () => {
  it('keeps known fields and shows unknown for anything missing', () => {
    const row = parseHeartbeat('pilot', heartbeat({ role: 'dispatch' }), NOW, STALE_S);
    expect(row).toMatchObject({
      id: 'pilot',
      bot: 'pilot',
      file: 'ok',
      red: false,
      reasons: [],
      role: 'dispatch',
      model: 'unknown',
      key_status: 'ok',
      key_checked_at: 'unknown',
      current_job: 'unknown',
      last_receipt_path: 'unknown',
      last_receipt_at: 'unknown',
      heartbeat_age_s: 30,
    });
    expect(row.heartbeat_at).toBe('2026-10-24T19:59:30.000Z');
  });

  it('does not guess a key status, a timestamp, or a mismatched bot', () => {
    const badKey = parseHeartbeat('pilot', heartbeat({ key_status: 'OK' }), NOW, STALE_S);
    expect(badKey.key_status).toBe('unknown');
    expect(badKey.file).toBe('invalid');
    expect(badKey.red).toBe(true);

    const badTime = parseHeartbeat('pilot', heartbeat({ heartbeat_at: 'yesterday' }), NOW, STALE_S);
    expect(badTime.heartbeat_at).toBe('unknown');
    expect(badTime.heartbeat_age_s).toBeNull();
    expect(badTime.file).toBe('invalid');

    const other = parseHeartbeat('pilot', heartbeat({ bot: 'stager', role: 'should-not-stick' }), NOW, STALE_S);
    expect(other.file).toBe('invalid');
    expect(other.bot).toBe('unknown');
    expect(other.role).toBe('unknown');
    expect(JSON.stringify(other)).not.toContain('should-not-stick');
  });
});

describe('ops lane staleness', () => {
  it('turns red only when the heartbeat is older than the threshold', () => {
    const exact = parseHeartbeat('pilot', heartbeat({
      heartbeat_at: new Date(NOW - 120_000).toISOString(),
    }), NOW, STALE_S);
    expect(exact.heartbeat_age_s).toBe(120);
    expect(exact.red).toBe(false);
    expect(exact.reasons).not.toContain('stale');

    const older = parseHeartbeat('pilot', heartbeat({
      heartbeat_at: new Date(NOW - 121_000).toISOString(),
    }), NOW, STALE_S);
    expect(older.heartbeat_age_s).toBe(121);
    expect(older.reasons).toEqual(['stale']);
    expect(older.red).toBe(true);

    const tighter = parseHeartbeat('pilot', heartbeat({
      heartbeat_at: new Date(NOW - 61_000).toISOString(),
    }), NOW, 60);
    expect(tighter.reasons).toContain('stale');

    const missingClock = parseHeartbeat('pilot', heartbeat({ heartbeat_at: '' }), NOW, STALE_S);
    expect(missingClock.heartbeat_at).toBe('unknown');
    expect(missingClock.reasons).not.toContain('stale');
  });
});

describe('ops lane red rules', () => {
  it('is red for an expired key, an auth error, a missing file, or invalid JSON', () => {
    const fresh = new Date(NOW).toISOString();
    const expired = parseHeartbeat('stager', JSON.stringify({ bot: 'stager', key_status: 'expired', heartbeat_at: fresh }), NOW, STALE_S);
    expect(expired.reasons).toEqual(['key']);
    expect(expired.red).toBe(true);
    expect(expired.file).toBe('ok');

    const authError = parseHeartbeat('scout', JSON.stringify({ bot: 'scout', key_status: 'auth_error', heartbeat_at: fresh }), NOW, STALE_S);
    expect(authError.reasons).toEqual(['key']);

    const ok = parseHeartbeat('scribe-clients', JSON.stringify({ bot: 'scribe-clients', key_status: 'ok', heartbeat_at: fresh }), NOW, STALE_S);
    expect(ok.red).toBe(false);

    const unknownKey = parseHeartbeat('scribe-hipsl', JSON.stringify({ bot: 'scribe-hipsl', heartbeat_at: fresh }), NOW, STALE_S);
    expect(unknownKey.key_status).toBe('unknown');
    expect(unknownKey.red).toBe(false);

    const missing = unreadLane('pilot', 'missing', NOW, STALE_S);
    expect(missing.red).toBe(true);
    expect(missing.reasons).toEqual(['missing']);
    expect(missing.role).toBe('unknown');

    const invalid = parseHeartbeat('pilot', '{', NOW, STALE_S);
    expect(invalid.file).toBe('invalid');
    expect(invalid.reasons).toEqual(['invalid']);
    expect(invalid.model).toBe('unknown');
    expect(invalid.current_job).toBe('unknown');
  });
});

describe('ops lane redaction', () => {
  it('redacts secret-looking values and drops every other field', () => {
    const row = parseHeartbeat('pilot', JSON.stringify({
      bot: 'pilot',
      role: 'dispatch',
      model: 'claude',
      key_status: 'ok',
      current_job: 'password=hunter2 token=sk-do-not-leak',
      heartbeat_at: new Date(NOW).toISOString(),
      last_receipt_path: 'Bearer eyJhbGciOiJIUzI1NiJ9.payloadxx.signaturex',
      note: 'ghp_1234567890abcdef',
    }), NOW, STALE_S);
    const body = JSON.stringify(row);
    expect(body).not.toContain('hunter2');
    expect(body).not.toContain('sk-do-not-leak');
    expect(body).not.toContain('ghp_');
    expect(body).not.toContain('eyJ');
    expect(body).toContain('[redacted]');
    expect(row.file).toBe('ok');
    expect(row.red).toBe(false);
  });

  it('does not return a secret stored in an illegal key status', () => {
    const row = parseHeartbeat('pilot', heartbeat({ key_status: 'sk-live-not-a-real-key' }), NOW, STALE_S);
    expect(row.key_status).toBe('unknown');
    expect(row.file).toBe('invalid');
    expect(JSON.stringify(row)).not.toContain('sk-live');
  });
});

describe('ops lane defaults', () => {
  it('uses the countix directory, a 10s poll, a 2 minute stale line, and the five bots', () => {
    const resolved = resolveOpsLanes(undefined);
    expect(resolved.dir).toBe(DEFAULT_OPS_DIR);
    expect(resolved.pollS).toBe(10);
    expect(resolved.staleMin).toBe(2);
    expect(resolved.staleS).toBe(120);
    expect(resolved.bots).toEqual([...DEFAULT_OPS_BOTS]);
    const custom = resolveOpsLanes({ ops_lanes: { stale_min: 1, poll_s: 5, bots: [], dir: '' } });
    expect(custom.staleS).toBe(60);
    expect(custom.pollS).toBe(5);
    expect(custom.bots).toEqual([]);
    expect(custom.dir).toBe('');
  });
});
