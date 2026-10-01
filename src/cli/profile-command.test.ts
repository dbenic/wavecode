import { describe, expect, it } from 'vitest';
import type { WaveConfig } from '../server/config.js';
import { buildLoginInvocation } from './profile-command.js';

function cfg(): WaveConfig {
  return {
    profiles_root: '/srv/profiles',
    profiles: { ana: {}, service: { shared: true } },
    runtimes: {
      'claude-code': { command: 'claude', idle_pattern: '>', env: { CLAUDE_CONFIG_DIR: '{profile_dir}/claude' }, login_command: 'claude /login' },
      codex: { command: 'codex', idle_pattern: '>', env: { CODEX_HOME: '{profile_dir}/codex' }, login_command: 'codex login' },
      aider: { command: 'aider', idle_pattern: '>' },
    },
  } as unknown as WaveConfig;
}

describe('wavecode profile login', () => {
  it('runs the runtime login command (no shell) with only the profile env, in the profile dir', () => {
    expect(buildLoginInvocation('ana', 'claude-code', cfg())).toEqual({
      ok: true,
      data: {
        command: 'claude',
        args: ['/login'],
        env: { CLAUDE_CONFIG_DIR: '/srv/profiles/ana/claude' },
        cwd: '/srv/profiles/ana',
        profile: 'ana',
      },
    });
    expect(buildLoginInvocation('ana', 'codex', cfg())).toMatchObject({
      ok: true, data: { command: 'codex', args: ['login'], env: { CODEX_HOME: '/srv/profiles/ana/codex' } },
    });
  });

  it('explains what is wrong', () => {
    expect(buildLoginInvocation('carol', 'codex', cfg())).toMatchObject({ ok: false, error: expect.stringMatching(/not configured \(configured: ana, service\)/) });
    expect(buildLoginInvocation('ana', 'nope', cfg())).toMatchObject({ ok: false, error: expect.stringMatching(/Unknown runtime 'nope'/) });
    expect(buildLoginInvocation('ana', 'aider', cfg())).toMatchObject({ ok: false, error: expect.stringMatching(/no login_command/) });
    expect(buildLoginInvocation('../etc', 'codex', cfg()).ok).toBe(false);
  });
});
