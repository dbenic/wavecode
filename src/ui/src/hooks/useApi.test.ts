import { describe, expect, it } from 'vitest';
import { buildAuthHeaders, buildEventStreamUrl } from './useApi';

describe('useApi auth helpers', () => {
  it('adds the bearer token while preserving existing headers', () => {
    expect(buildAuthHeaders('secret-token', { Accept: 'application/json' })).toEqual({
      Accept: 'application/json',
      Authorization: 'Bearer secret-token',
    });
  });

  it('does not add authorization when no token is present', () => {
    expect(buildAuthHeaders(null, { Accept: 'application/json' })).toEqual({
      Accept: 'application/json',
    });
  });

  it('builds SSE URLs with replay and token parameters', () => {
    expect(
      buildEventStreamUrl('http://localhost:3777', 42, 'secret-token'),
    ).toBe('http://localhost:3777/api/events?lastEventId=42&access_token=secret-token');
  });
});
