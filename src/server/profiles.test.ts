/**
 * Credential profiles (spec §5): env injection per runtime on every launch
 * path, strict validation, spawn profile resolution, and the
 * profile-compatible "free" rule. Real config + SQLite; tmux is faked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmuxHarness = vi.hoisted(() => ({
  sessions: new Set<string>(),
  launched: [] as Array<{ session: string; dir: string; command?: string }>,
  typed: [] as Array<{ session: string; text: string }>,
}));

vi.mock('./tmux.js', () => ({
  hasSession: vi.fn((s: string) => tmuxHarness.sessions.has(s)),
  newSession: vi.fn((session: string, dir: string, command?: string) => {
    tmuxHarness.sessions.add(session);
    tmuxHarness.launched.push({ session, dir, command });
  }),
  killSession: vi.fn((s: string) => tmuxHarness.sessions.delete(s)),
  sendTextAndEnter: vi.fn((session: string, text: string) => tmuxHarness.typed.push({ session, text })),
  capturePane: vi.fn(() => ({ ok: true, data: 'ci@box:~$ ' })),
  isValidSessionName: vi.fn(() => true),
}));

vi.mock('./runner.js', () => ({
  startRunner: vi.fn(),
  stopRunner: vi.fn(),
}));

vi.mock('./logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('credential profiles', () => {
  let tmpDir: string;
  let root: string;
  let db: typeof import('./db.js');
  let profiles: typeof import('./profiles.js');
  let launcher: typeof import('./runtime-launcher.js');

  function writeConfig(extra: string[] = []) {
    fs.writeFileSync(path.join(tmpDir, 'config.yaml'), [
      `profiles_root: ${root}`,
      'profiles:',
      '  ana: {}',
      '  bob: {}',
      '  service: { shared: true }',
      'artifacts:',
      `  storage: ${path.join(tmpDir, 'artifacts')}`,
      ...extra,
      '',
    ].join('\n'));
  }

  beforeEach(async () => {
    tmuxHarness.sessions.clear();
    tmuxHarness.launched.length = 0;
    tmuxHarness.typed.length = 0;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wavecode-profiles-'));
    root = path.join(tmpDir, 'profiles');
    writeConfig();
    (await import('./config.js')).loadConfig(path.join(tmpDir, 'config.yaml'));
    db = await import('./db.js');
    db.resetDbForTest();
    db.initDb(path.join(tmpDir, 'test.db'));
    profiles = await import('./profiles.js');
    launcher = await import('./runtime-launcher.js');
  });

  afterEach(() => {
    db.resetDbForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('env injection per runtime', () => {
    it('claude-code → CLAUDE_CONFIG_DIR, with the model pin', () => {
      expect(launcher.buildLaunchCommand('claude-code', { profile: 'ana', model: 'opus' })).toEqual({
        ok: true,
        data: `env CLAUDE_CONFIG_DIR=${root}/ana/claude claude --dangerously-skip-permissions --model opus`,
      });
    });

    it('codex → CODEX_HOME, with the effort pin', () => {
      expect(launcher.buildLaunchCommand('codex', { profile: 'bob', effort: 'xhigh' })).toEqual({
        ok: true,
        data: `env CODEX_HOME=${root}/bob/codex codex --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust -c model_reasoning_effort=xhigh`,
      });
    });

    it('grok → HOME override for that process only (env keeps PATH)', () => {
      expect(launcher.buildLaunchCommand('grok', { profile: 'ana' })).toEqual({
        ok: true,
        data: `env HOME=${root}/ana/grok-home grok --always-approve`,
      });
    });

    it('a config.yaml that overrides runtimes keeps the built-in profile env', async () => {
      writeConfig(['runtimes:', '  claude-code:', '    command: claude --dangerously-skip-permissions --verbose', "    idle_pattern: '>'"]);
      (await import('./config.js')).loadConfig(path.join(tmpDir, 'config.yaml'));
      expect(launcher.buildLaunchCommand('claude-code', { profile: 'ana' })).toEqual({
        ok: true,
        data: `env CLAUDE_CONFIG_DIR=${root}/ana/claude claude --dangerously-skip-permissions --verbose`,
      });
    });

    it('no profile → the plain command, exactly as before profiles existed', () => {
      expect(launcher.buildLaunchCommand('claude-code', { profile: null })).toEqual({
        ok: true, data: 'claude --dangerously-skip-permissions',
      });
      // A runtime without env templates on a profile also launches unchanged
      expect(launcher.buildLaunchCommand('aider', { profile: 'ana' })).toEqual({ ok: true, data: 'aider --yes' });
    });
  });

  describe('validation', () => {
    it('rejects unsafe env values and keys', () => {
      for (const bad of ['/a b', '/x;rm -rf /', '/x$(id)', '/x`id`', '/a/../etc', '~/x', '/x|y', "/x'y", '']) {
        expect(profiles.isSafeEnvValue(bad), bad).toBe(false);
      }
      for (const good of ['/srv/profiles/ana/claude', '/home/ci/.wavecode-data/p/grok-home', 'relative/dir']) {
        expect(profiles.isSafeEnvValue(good), good).toBe(true);
      }
      expect(profiles.isSafeEnvKey('CLAUDE_CONFIG_DIR')).toBe(true);
      expect(profiles.isSafeEnvKey('lower')).toBe(false);
      expect(profiles.isSafeEnvKey('A=B')).toBe(false);
    });

    it('buildRuntimeCommand never shell-embeds an unsafe pair', () => {
      const cmd = launcher.buildRuntimeCommand(
        { command: 'claude', idle_pattern: '' },
        { env: { GOOD: '/ok', BAD: '/x; rm -rf ~', 'NO SPACE': '/y' } },
      );
      expect(cmd).toBe('env GOOD=/ok claude');
    });

    it('resolveProfileEnv: invalid name, unconfigured profile, unknown runtime, bad template', async () => {
      expect(profiles.resolveProfileEnv('claude-code', 'Ana!')).toMatchObject({ ok: false });
      expect(profiles.resolveProfileEnv('claude-code', 'carol')).toEqual({ ok: false, error: "Profile 'carol' is not configured" });
      expect(profiles.resolveProfileEnv('nope', 'ana')).toEqual({ ok: false, error: "Unknown runtime 'nope'" });

      writeConfig(['runtimes:', '  claude-code:', '    command: claude', "    idle_pattern: '>'", '    env:', "      CLAUDE_CONFIG_DIR: '{profile_dir}/{user}'"]);
      (await import('./config.js')).loadConfig(path.join(tmpDir, 'config.yaml'));
      expect(profiles.resolveProfileEnv('claude-code', 'ana')).toMatchObject({ ok: false, error: expect.stringMatching(/Unknown placeholder/) });
      expect(launcher.buildLaunchCommand('claude-code', { profile: 'ana' }).ok).toBe(false);
    });

    it('config load fails fast on a bad profile name or unsafe profiles_root', async () => {
      const config = await import('./config.js');
      fs.writeFileSync(path.join(tmpDir, 'config.yaml'), `profiles:\n  "Bad Name": {}\nartifacts:\n  storage: ${tmpDir}/a\n`);
      expect(() => config.loadConfig(path.join(tmpDir, 'config.yaml'))).toThrow(/Invalid credential profile config/);
      fs.writeFileSync(path.join(tmpDir, 'config.yaml'), `profiles_root: "/srv/my profiles"\nprofiles:\n  ana: {}\nartifacts:\n  storage: ${tmpDir}/a\n`);
      expect(() => config.loadConfig(path.join(tmpDir, 'config.yaml'))).toThrow(/profiles_root/);
    });
  });

  describe('launch paths carry the profile', () => {
    it('spawn records the profile and launches with its env', async () => {
      const sm = await import('./session-manager.js');
      const res = sm.spawnAgent({ name: 'ana-cc', runtime: 'claude-code', workspace: tmpDir, profile: 'ana' });
      expect(res.ok && res.data.profile).toBe('ana');
      expect(tmuxHarness.launched.at(-1)?.command).toBe(`env CLAUDE_CONFIG_DIR=${root}/ana/claude claude --dangerously-skip-permissions`);
    });

    it('spawn on an unconfigured profile creates nothing', async () => {
      const sm = await import('./session-manager.js');
      const res = sm.spawnAgent({ name: 'x', runtime: 'claude-code', workspace: tmpDir, profile: 'carol' });
      expect(res).toEqual({ ok: false, error: "Profile 'carol' is not configured" });
      expect(tmuxHarness.launched).toHaveLength(0);
      expect(db.listAgents()).toHaveLength(0);
    });

    it('restart (crashed session) relaunches on the same profile', async () => {
      const sm = await import('./session-manager.js');
      const spawned = sm.spawnAgent({ name: 'bob-cx', runtime: 'codex', workspace: tmpDir, profile: 'bob' });
      if (!spawned.ok) throw new Error(spawned.error);
      tmuxHarness.sessions.clear(); // session died
      const restarted = sm.ensureSpawnedAgentSession(spawned.data.id);
      expect(restarted.ok && restarted.data.createdSession).toBe(true);
      expect(tmuxHarness.launched.at(-1)?.command).toMatch(new RegExp(`^env CODEX_HOME=${root}/bob/codex codex `));
    });

    it('upgrade (adopted → spawned) launches on the agent\'s profile', async () => {
      const sm = await import('./session-manager.js');
      const adopted = db.insertAgent({ name: 'grok-ana', runtime: 'grok', tmux_session: 'manual-1', workspace: null, mode: 'adopted', status: 'idle', profile: 'ana' });
      if (!adopted.ok) throw new Error(adopted.error);
      const upgraded = sm.upgrade(adopted.data.id);
      expect(upgraded.ok).toBe(true);
      expect(tmuxHarness.launched.at(-1)?.command).toBe(`env HOME=${root}/ana/grok-home grok --always-approve`);
    });

    it('T0 runtime relaunch uses the profile env too', async () => {
      const liveness = await import('./runtime-liveness.js');
      const agent = db.insertAgent({ name: 'a', runtime: 'claude-code', tmux_session: 'wc-a', workspace: null, mode: 'spawned', status: 'idle', profile: 'ana' });
      if (!agent.ok) throw new Error(agent.error);
      expect(liveness.relaunchRuntime(agent.data, 'manual').ok).toBe(true);
      // first relaunch resumes the previous conversation (resume_args), still under the profile env
      expect(tmuxHarness.typed.at(-1)?.text).toBe(`env CLAUDE_CONFIG_DIR=${root}/ana/claude claude --dangerously-skip-permissions --continue`);
    });
  });

  describe('public (pool) profiles', () => {
    it('agents on a public profile are usable by every user; spawning on it still needs an admin', () => {
      const cfg = { profiles: { denis: {}, pool: { public: true } }, profiles_root: '/p', runtimes: {} } as never;
      const ana = { role: 'developer' as const, profile: 'ana' };
      expect(profiles.isProfileCompatible('pool', ana, cfg)).toBe(true);
      expect(profiles.isProfileCompatible('pool', null, cfg)).toBe(true);
      expect(profiles.isProfileCompatible('denis', ana, cfg)).toBe(false);
      expect(profiles.resolveSpawnProfile(ana, 'pool', cfg)).toMatchObject({ ok: false, code: 'forbidden' });
    });
  });

  describe('resolveSpawnProfile', () => {
    const ana = { role: 'developer' as const, profile: 'ana' };
    const admin = { role: 'admin' as const, profile: null };

    it('uses the caller\'s own profile by default; the owner stays on the home login', () => {
      expect(profiles.resolveSpawnProfile(ana, undefined)).toEqual({ ok: true, data: 'ana' });
      expect(profiles.resolveSpawnProfile(admin, undefined)).toEqual({ ok: true, data: null });
    });

    it('non-admins cannot pick another profile (or the home login); admins can', () => {
      expect(profiles.resolveSpawnProfile(ana, 'bob')).toMatchObject({ ok: false, code: 'forbidden' });
      expect(profiles.resolveSpawnProfile(ana, null)).toMatchObject({ ok: false, code: 'forbidden' });
      expect(profiles.resolveSpawnProfile(ana, 'ana')).toEqual({ ok: true, data: 'ana' });
      expect(profiles.resolveSpawnProfile(admin, 'bob')).toEqual({ ok: true, data: 'bob' });
      expect(profiles.resolveSpawnProfile(admin, null)).toEqual({ ok: true, data: null });
      expect(profiles.resolveSpawnProfile(admin, 'carol')).toMatchObject({ ok: false, code: 'invalid' });
    });

    it('shared profiles are admin-only', () => {
      expect(profiles.resolveSpawnProfile(admin, 'service')).toEqual({ ok: true, data: 'service' });
      expect(profiles.resolveSpawnProfile({ role: 'developer', profile: 'service' }, undefined)).toMatchObject({ ok: false, code: 'forbidden' });
    });

    it('an unconfigured own profile is an actionable error', () => {
      expect(profiles.resolveSpawnProfile({ role: 'developer', profile: 'carol' }, undefined))
        .toMatchObject({ ok: false, error: expect.stringMatching(/'carol' is not configured/) });
    });

    it('profiles off → everyone on the home login', async () => {
      fs.writeFileSync(path.join(tmpDir, 'config.yaml'), `artifacts:\n  storage: ${tmpDir}/a\n`);
      (await import('./config.js')).loadConfig(path.join(tmpDir, 'config.yaml'));
      expect(profiles.resolveSpawnProfile(ana, undefined)).toEqual({ ok: true, data: null });
    });
  });

  describe('free rule (profile-compatible)', () => {
    it('isProfileCompatible: same profile only; shared → admins/system; no profile → everyone', () => {
      const ana = { role: 'developer' as const, profile: 'ana' };
      const bob = { role: 'developer' as const, profile: 'bob' };
      const admin = { role: 'admin' as const, profile: null };
      expect(profiles.isProfileCompatible('ana', ana)).toBe(true);
      expect(profiles.isProfileCompatible('ana', bob)).toBe(false);
      expect(profiles.isProfileCompatible('ana', admin)).toBe(false); // not even admins burn ana's quota
      expect(profiles.isProfileCompatible('ana', null)).toBe(false);
      expect(profiles.isProfileCompatible('service', admin)).toBe(true);
      expect(profiles.isProfileCompatible('service', ana)).toBe(false);
      expect(profiles.isProfileCompatible('service', null)).toBe(true);
      expect(profiles.isProfileCompatible(null, bob)).toBe(true);
    });

    it('leases.waitReason applies it to free and owned agents alike', async () => {
      const { createUser } = await import('./users.js');
      const leases = await import('./leases.js');
      const ana = createUser({ name: 'ana' });
      const bob = createUser({ name: 'bob' });
      if (!ana.ok || !bob.ok) throw new Error('users');
      const seat = db.insertAgent({ name: 's', runtime: 'claude-code', tmux_session: 'wc-s', workspace: null, mode: 'spawned', status: 'idle', profile: 'ana' });
      if (!seat.ok) throw new Error(seat.error);
      const task = (by: string) => {
        const t = db.insertTask({ prompt: 'x', created_by: by });
        if (!t.ok) throw new Error(t.error);
        return t.data;
      };

      expect(leases.waitReason(task(ana.data.user.id), seat.data)).toBeNull();
      expect(leases.waitReason(task(bob.data.user.id), seat.data)).toBe('profile');
      expect(leases.waitReason(task('owner'), seat.data)).toBe('profile');

      // Even if bob somehow held the lease, his task would not run on ana's subscription
      const owned = { ...seat.data, owner_id: bob.data.user.id, lease_reason: 'reserved' as const };
      expect(leases.canDispatchTaskToAgent(task(bob.data.user.id), owned)).toBe(false);
    });
  });

  it('profileStatuses reports credential presence only', () => {
    fs.mkdirSync(path.join(root, 'ana', 'claude'), { recursive: true });
    fs.writeFileSync(path.join(root, 'ana', 'claude', '.credentials.json'), '{"secret":"do-not-leak"}');
    const statuses = profiles.profileStatuses();
    expect(statuses.map((s) => s.name)).toEqual(['ana', 'bob', 'service']);
    const ana = statuses.find((s) => s.name === 'ana')!;
    expect(ana.runtimes['claude-code']).toEqual({ logged_in: true });
    expect(ana.runtimes.codex).toEqual({ logged_in: false });
    expect(statuses.find((s) => s.name === 'service')?.shared).toBe(true);
    expect(JSON.stringify(statuses)).not.toContain('do-not-leak');
    expect(JSON.stringify(statuses)).not.toContain(root); // no paths either
  });
});
