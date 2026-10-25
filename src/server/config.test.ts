/**
 * Phase 1 Security Tests — config.ts (file permissions, key masking)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('config.ts — security', () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wavecode-test-'));
    configPath = path.join(tmpDir, 'config.yaml');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.resetModules();
  });

  it('writes config.yaml with restricted permissions (0600)', async () => {
    // Import fresh module to avoid cached state
    const { loadConfig, updateConfig } = await import('./config.js');

    // Load config pointing to our temp file
    loadConfig(configPath);

    // Update config to trigger a write
    updateConfig({ server: { port: 4000, host: '0.0.0.0' } });

    // Verify the file exists
    expect(fs.existsSync(configPath)).toBe(true);

    // Check file permissions (Unix only)
    if (process.platform !== 'win32') {
      const stat = fs.statSync(configPath);
      const mode = stat.mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it('defaults Codex effort_flag so high/xhigh pins are injected', async () => {
    const { loadConfig, getConfig } = await import('./config.js');
    loadConfig(configPath);
    expect(getConfig().runtimes.codex?.effort_flag).toBe('-c model_reasoning_effort=');
    expect(getConfig().projects).toEqual({});
  });

  it('loads production_approvers and rejects a list that is not user names', async () => {
    fs.writeFileSync(configPath, 'releases:\n  production_approvers: [denis]\n', 'utf8');
    const { loadConfig } = await import('./config.js');
    expect(loadConfig(configPath).releases?.production_approvers).toEqual(['denis']);

    fs.writeFileSync(configPath, 'releases:\n  production_approvers: []\n', 'utf8');
    vi.resetModules();
    const empty = await import('./config.js');
    expect(empty.loadConfig(configPath).releases?.production_approvers).toEqual([]);

    fs.writeFileSync(configPath, 'releases:\n  production_approvers: [Denis Admin]\n', 'utf8');
    vi.resetModules();
    const bad = await import('./config.js');
    expect(() => bad.loadConfig(configPath)).toThrow(/production_approvers/);
  });

  it('loads a staging command argv and requires its placeholder', async () => {
    fs.writeFileSync(configPath, `
releases:
  staging_command: ["staging-deploy", "--exact-sha", "{sha}", "--lane", "{lane}", "--desk", "{desk}"]
  staging_watch_command: ["staging-deploy", "watch", "{deploy_id}"]
`, 'utf8');
    const { loadConfig } = await import('./config.js');
    const loaded = loadConfig(configPath);
    expect(loaded.releases?.staging_command).toEqual(['staging-deploy', '--exact-sha', '{sha}', '--lane', '{lane}', '--desk', '{desk}']);
    expect(loaded.releases?.staging_watch_command?.[2]).toBe('{deploy_id}');

    fs.writeFileSync(configPath, 'releases:\n  staging_command: ["staging-deploy", "--progress-json"]\n', 'utf8');
    vi.resetModules();
    const missing = await import('./config.js');
    expect(() => missing.loadConfig(configPath)).toThrow(/staging_command must include \{sha\}/);
  });

  it('keeps pipeline switches off unless set, and requires the push placeholder', async () => {
    fs.writeFileSync(configPath, `
projects:
  demo:
    pipeline:
      auto_freeze: false
      push_command: [git, '-C', '{workspace}', 'push', 'origin', 'HEAD:{lane}']
      review_deny: [codex1]
      lane_deny: ['wc-codex1', 'wc-codex*']
      agent_deny: [codex1]
      reviewer_prefer:
        claude: [codex2, codex3]
        codex: [claude1, claude2]
      reviewer_pool_by_author_glob:
        'ales-*': [ales-codex1]
      review_reassign_minutes: 15
`, 'utf8');
    const { loadConfig } = await import('./config.js');
    const loaded = loadConfig(configPath);
    expect(loaded.projects?.demo.pipeline?.auto_freeze).toBe(false);
    expect(loaded.projects?.demo.pipeline?.auto_stage).toBeUndefined();
    expect(loaded.projects?.demo.pipeline?.review_deny).toEqual(['codex1']);
    expect(loaded.projects?.demo.pipeline?.lane_deny).toEqual(['wc-codex1', 'wc-codex*']);
    expect(loaded.projects?.demo.pipeline?.agent_deny).toEqual(['codex1']);
    expect(loaded.projects?.demo.pipeline?.reviewer_prefer).toEqual({ claude: ['codex2', 'codex3'], codex: ['claude1', 'claude2'] });
    expect(loaded.projects?.demo.pipeline?.reviewer_pool_by_author_glob).toEqual({ 'ales-*': ['ales-codex1'] });
    expect(loaded.projects?.demo.pipeline?.review_reassign_minutes).toBe(15);

    fs.writeFileSync(configPath, 'projects:\n  demo:\n    pipeline:\n      push_command: [git, push]\n', 'utf8');
    vi.resetModules();
    const missing = await import('./config.js');
    expect(() => missing.loadConfig(configPath)).toThrow(/push_command must include \{lane\}/);

    const refuse = async (yaml: string, pattern: RegExp) => {
      fs.writeFileSync(configPath, yaml, 'utf8');
      vi.resetModules();
      const loaded = await import('./config.js');
      expect(() => loaded.loadConfig(configPath)).toThrow(pattern);
    };
    await refuse('projects:\n  demo:\n    pipeline:\n      push_command: [bash, -c, "git push origin HEAD:{lane}"]\n', /must not pass \{lane\} through a shell/);
    await refuse('projects:\n  demo:\n    pipeline:\n      push_command: [sh, -c, "git push origin {lane}"]\n', /must not pass \{lane\} through a shell/);
    await refuse('projects:\n  demo:\n    pipeline:\n      push_command: [bash, -lc, "git push origin HEAD:{lane}"]\n', /must not pass \{lane\} through a shell/);
    await refuse('projects:\n  demo:\n    pipeline:\n      push_command: [git, push, origin, "refs/heads/{lane}"]\n', /its own argument or as a HEAD:\{lane\} refspec/);
    await refuse('projects:\n  demo:\n    pipeline:\n      agent_deny: ["not a name"]\n', /agent_deny must be a list of agent names/);
    await refuse('projects:\n  demo:\n    pipeline:\n      lane_deny: [""]\n', /lane_deny must be a list of globs/);
    await refuse('projects:\n  demo:\n    pipeline:\n      reviewer_prefer:\n        claude: ["not a name"]\n', /reviewer_prefer values must be lists of agent names/);
    await refuse('projects:\n  demo:\n    pipeline:\n      reviewer_prefer:\n        "not a vendor": [codex2]\n', /reviewer_prefer keys must be vendor names/);
    await refuse("projects:\n  demo:\n    pipeline:\n      reviewer_pool_by_author_glob:\n        '..': [ales-codex1]\n", /reviewer_pool_by_author_glob keys must be author globs/);
    await refuse('projects:\n  demo:\n    pipeline:\n      review_reassign_minutes: -1\n', /review_reassign_minutes must be a number of minutes/);
    await refuse('projects:\n  demo:\n    pipeline:\n      review_reassign_minutes: 1441\n', /review_reassign_minutes must be a number of minutes/);
  });

  it('loads a per-project referee profile from yaml', async () => {
    fs.writeFileSync(configPath, `
projects:
  wavepulse:
    workspace_match: '**/wavepulse*'
    gate:
      command: wavepulse-gate
      branch: landing-v3-human-first
      mode: full
      baseline_glob: ~/gate-results/landing-v3-human-first-*-full.log
    require_result_to_promote: true
`, 'utf8');

    const { loadConfig } = await import('./config.js');
    const cfg = loadConfig(configPath);
    expect(cfg.projects.wavepulse?.workspace_match).toBe('**/wavepulse*');
    expect(cfg.projects.wavepulse?.gate?.command).toBe('wavepulse-gate');
    expect(cfg.projects.wavepulse?.gate?.branch).toBe('landing-v3-human-first');
    expect(cfg.projects.wavepulse?.gate?.mode).toBe('full');
    expect(cfg.projects.wavepulse?.require_result_to_promote).toBe(true);
  });

  it('uses the live no-click bypass runtime commands', async () => {
    const { loadConfig, updateConfig, getConfig } = await import('./config.js');

    loadConfig(configPath);
    updateConfig({ server: { port: 4000, host: '0.0.0.0' } });

    const cfg = getConfig();
    expect(cfg.runtimes['claude-code']?.command).toBe('claude --dangerously-skip-permissions');
    expect(cfg.runtimes.grok?.command).toBe('grok --always-approve');
    expect(cfg.runtimes.codex?.command).toBe(
      'codex --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust',
    );
  });

  it('ignores disallowed top-level updates such as auth overrides', async () => {
    const { loadConfig, updateConfig, getConfig } = await import('./config.js');

    loadConfig(configPath);

    updateConfig({
      auth: {
        method: 'token',
        fallback_token: 'should-not-apply',
        trusted_proxies: ['loopback'],
      },
    } as unknown as Parameters<typeof updateConfig>[0]);

    expect(getConfig().auth).toEqual({
      method: 'token',
      fallback_token: null,
      trusted_proxies: [],
    });
  });

  it('expands home-relative paths and resolves relative paths from the config directory', async () => {
    fs.writeFileSync(configPath, `
paths:
  projects_root: ~/WaveProjects
  guides_root: guides
artifacts:
  storage: .wavecode-artifacts
`, 'utf8');

    const { loadConfig } = await import('./config.js');
    const cfg = loadConfig(configPath);

    expect(cfg.paths.projects_root).toBe(path.join(os.homedir(), 'WaveProjects'));
    expect(cfg.paths.guides_root).toBe(path.join(tmpDir, 'guides'));
    expect(cfg.artifacts.storage).toBe(path.join(tmpDir, '.wavecode-artifacts'));
  });

  it('builds default filesystem paths relative to the config location', async () => {
    const { loadConfig } = await import('./config.js');
    const cfg = loadConfig(configPath);

    expect(cfg.paths.worktrees_root).toBe(path.join(tmpDir, '.wavecode-data', 'worktrees'));
    expect(cfg.paths.transcripts_root).toBe(path.join(tmpDir, '.wavecode-data', 'transcripts'));
    expect(cfg.paths.teams_root).toBe(path.join(tmpDir, 'teams'));
  });

  it('creates the artifact storage directory at startup if it does not exist', async () => {
    const storageDir = path.join(tmpDir, 'fresh-storage');
    fs.writeFileSync(configPath, `
artifacts:
  storage: ${storageDir}
`, 'utf8');

    const { loadConfig } = await import('./config.js');
    expect(() => loadConfig(configPath)).not.toThrow();
    expect(fs.existsSync(storageDir)).toBe(true);
  });

  it('throws a clear error when artifact storage cannot be created (unwritable parent)', async () => {
    if (process.platform === 'win32') return; // permissions semantics differ on Windows

    // Build a path under an unwritable parent so mkdir fails
    const lockedParent = path.join(tmpDir, 'locked');
    fs.mkdirSync(lockedParent);
    fs.chmodSync(lockedParent, 0o555); // read+execute, no write

    const storageDir = path.join(lockedParent, 'storage');
    fs.writeFileSync(configPath, `
artifacts:
  storage: ${storageDir}
`, 'utf8');

    const { loadConfig } = await import('./config.js');
    expect(() => loadConfig(configPath)).toThrow(/Cannot create artifact storage directory/);

    // Restore so afterEach cleanup can rm -rf
    fs.chmodSync(lockedParent, 0o755);
  });

  it('throws a clear error when artifact storage exists but is not writable', async () => {
    if (process.platform === 'win32') return;
    if (process.getuid && process.getuid() === 0) return; // root bypasses permissions

    const storageDir = path.join(tmpDir, 'readonly-storage');
    fs.mkdirSync(storageDir);
    fs.chmodSync(storageDir, 0o555);

    fs.writeFileSync(configPath, `
artifacts:
  storage: ${storageDir}
`, 'utf8');

    const { loadConfig } = await import('./config.js');
    expect(() => loadConfig(configPath)).toThrow(/not writable/);

    fs.chmodSync(storageDir, 0o755);
  });
});

describe('config.ts — pipeline speed-ups and first pass', () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wavecode-test-'));
    configPath = path.join(tmpDir, 'config.yaml');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.resetModules();
  });

  it('loads the gate, capacity, allowlist and first-pass settings; quick and gate commands need no {sha}', async () => {
    fs.writeFileSync(configPath, `
review:
  min_capacity_pct: 10
  first_pass:
    enabled: true
    seats: [codex2, codex3]
    dir: /home/wave/inbox
    timeout_min: 20
projects:
  demo:
    pipeline:
      auto_gate: true
      gate_with_quick: true
      gate_timeout_min: 120
      quick_check_timeout_min: 20
      max_lane_files: 40
      quick_check_command: [countix-remote-test, tier1]
      gate_command: [countix-remote-test, --suite, api]
      reviewer_allow: [codex4, codex5, codex2, codex3, claude1, claude2]
      service_profiles: [denis20x]
`, 'utf8');
    const { loadConfig } = await import('./config.js');
    const loaded = loadConfig(configPath);
    expect(loaded.review.min_capacity_pct).toBe(10);
    expect(loaded.review.first_pass).toEqual({ enabled: true, seats: ['codex2', 'codex3'], dir: '/home/wave/inbox', timeout_min: 20 });
    const pipe = loaded.projects?.demo.pipeline;
    expect(pipe?.gate_with_quick).toBe(true);
    expect(pipe?.gate_command).toEqual(['countix-remote-test', '--suite', 'api']);
    expect(pipe?.reviewer_allow).toEqual(['codex4', 'codex5', 'codex2', 'codex3', 'claude1', 'claude2']);
    expect(pipe?.service_profiles).toEqual(['denis20x']);

    const refuse = async (yaml: string, pattern: RegExp) => {
      fs.writeFileSync(configPath, yaml, 'utf8');
      vi.resetModules();
      const fresh = await import('./config.js');
      expect(() => fresh.loadConfig(configPath)).toThrow(pattern);
    };
    await refuse('projects:\n  demo:\n    pipeline:\n      gate_timeout_min: -1\n', /gate_timeout_min must be a whole number/);
    await refuse('projects:\n  demo:\n    pipeline:\n      gate_with_quick: yes please\n', /gate_with_quick must be a boolean/);
    await refuse('projects:\n  demo:\n    pipeline:\n      gate_max_inflight: 0\n', /gate_max_inflight must be a whole number from 1 to 50/);
    await refuse('projects:\n  demo:\n    pipeline:\n      merge_queue:\n        gate_command: full\n', /merge_queue\.gate_command/);
    await refuse('projects:\n  demo:\n    pipeline:\n      reviewer_allow: ["not a name"]\n', /reviewer_allow must be a list of agent names/);
    await refuse('projects:\n  demo:\n    pipeline:\n      gate_command: [sh, -c, "echo {lane}"]\n', /must not pass \{lane\} through a shell/);
    await refuse('review:\n  min_capacity_pct: 101\n', /min_capacity_pct must be a percentage/);
    await refuse('review:\n  first_pass:\n    enabled: true\n', /first_pass.seats must name at least one seat/);
    await refuse('review:\n  first_pass:\n    seats: [codex2]\n    timeout_min: 0\n', /first_pass.timeout_min/);
  });

  it('loads the merge queue block and refuses bad values', async () => {
    fs.writeFileSync(configPath, `
projects:
  demo:
    migrations_dir: migrations
    pipeline:
      gate_command: [countix-remote-test, --suite, api]
      merge_queue:
        enabled: true
        ask_paths: ["**/payroll/**", "src/server/vat/*", migrations]
        default_tier: ask
        version_command: [node, scripts/bump-version.mjs]
        pr_list_command: [gh, pr, list, --json, "number,headRefName,headRefOid,state"]
        require_pr: true
        maestro_log: /home/wave/inbox/wavecode-merge-queue.log
        gate_timeout_min: 90
`, 'utf8');
    const { loadConfig } = await import('./config.js');
    const mq = loadConfig(configPath).projects?.demo.pipeline?.merge_queue;
    expect(mq).toEqual({
      enabled: true, ask_paths: ['**/payroll/**', 'src/server/vat/*', 'migrations'], default_tier: 'ask',
      version_command: ['node', 'scripts/bump-version.mjs'], pr_list_command: ['gh', 'pr', 'list', '--json', 'number,headRefName,headRefOid,state'],
      require_pr: true, maestro_log: '/home/wave/inbox/wavecode-merge-queue.log', gate_timeout_min: 90,
    });
    const refuse = async (yaml: string, pattern: RegExp) => {
      fs.writeFileSync(configPath, yaml, 'utf8');
      vi.resetModules();
      const fresh = await import('./config.js');
      expect(() => fresh.loadConfig(configPath)).toThrow(pattern);
    };
    await refuse('projects:\n  demo:\n    pipeline:\n      merge_queue:\n        enabled: "yes"\n', /merge_queue.enabled must be a boolean/);
    await refuse('projects:\n  demo:\n    pipeline:\n      merge_queue:\n        default_tier: maybe\n', /default_tier must be ship, show or ask/);
    await refuse('projects:\n  demo:\n    pipeline:\n      merge_queue:\n        ask_paths: ["/etc/**"]\n', /ask_paths must be a list of relative path globs/);
    await refuse('projects:\n  demo:\n    pipeline:\n      merge_queue:\n        maestro_log: /home/wave/inbox/queue.json\n', /maestro_log must be a \.log, \.txt or \.md file path/);
    await refuse('projects:\n  demo:\n    pipeline:\n      merge_queue:\n        gate_timeout_min: 0\n', /gate_timeout_min must be a whole number of minutes from 1 to 1440/);
    await refuse('projects:\n  demo:\n    pipeline:\n      merge_queue: [enabled]\n', /merge_queue must be a map/);
  });
});
