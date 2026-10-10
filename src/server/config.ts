import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { validateProfilesConfig } from './profile-validation.js';

export interface RuntimeConfig {
  command: string;
  idle_pattern: string;
  /** CLI flag used to pass a pinned model (e.g. '--model'). Unset = pin is recorded but not injected. */
  model_flag?: string;
  /** CLI flag used to pass a pinned reasoning effort (e.g. '--effort'). Unset = pin is recorded but not injected. */
  effort_flag?: string;
  /**
   * Appended when WaveCode relaunches a runtime that ran before in this
   * worktree, so the CLI resumes its previous conversation instead of
   * starting blank (`--continue` for Claude Code, `resume --last` for Codex).
   * The first relaunch attempt resumes; if the runtime dies again it is
   * launched plain, so a missing session can never loop.
   */
  resume_args?: string;
  /**
   * Env injected at launch when the agent runs on a credential profile
   * (spec §5). Values are templates; `{profile_dir}` → `<profiles_root>/<profile>`.
   */
  env?: Record<string, string>;
  /** Command a login seat runs for this runtime (e.g. `claude /login`). */
  login_command?: string;
  /** Files whose presence means "logged in" (templates, `{profile_dir}`). Contents are never read. */
  credential_files?: string[];
  /** How prompts enter the TUI: 'paste' (bracketed paste + confirmed Enter, default) or 'type' (chunked keystrokes). */
  input_mode?: 'paste' | 'type';
  // Future deploy agent fields (optional)
  scope?: string;
  claude_md?: string;
  workspace?: string;
  ssh_key?: string;
}

export interface ProjectGateConfig {
  /** Executable on PATH or an absolute path. WaveCode never cds into a worktree. */
  command: string;
  /** Shared-checkout branch the referee fetches (e.g. landing-v3-human-first). */
  branch: string;
  /** Promote always uses full. */
  mode?: 'fast' | 'full';
  /**
   * Newest matching nightly `*-full.log` used as the known-red baseline.
   * If omitted, WaveCode looks for `~/gate-results/<branch-with-/-as-->-*-full.log`.
   */
  baseline_glob?: string;
}

export interface ProjectConfig {
  // Glob or prefix matched against agents.workspace (e.g. "**/" + "wavepulse*").
  workspace_match: string;
  gate?: ProjectGateConfig;
  /** When a gate is configured this defaults to true — RESULT is required to promote. */
  require_result_to_promote?: boolean;
  /** Optional per-agent branch override (agent name → branch). */
  agent_branches?: Record<string, string>;
  /** Base clone agents get worktrees of (e.g. /home/wave/repos/wavepulse). Told to seats; default repo for spawns. */
  repo?: string;
  /**
   * `peer/agent` (e.g. `deploy/fable`) that receives the release GO when a
   * person promotes a run of this project. The message is attributed to that
   * person ("Release GO from denis via WaveCode Promote"); agents cannot
   * produce it — their ASK lines always arrive as questions.
   */
  release_peer?: string;
  /**
   * Run in every new worktree right after it is created, as the service user
   * (e.g. `npm ci --no-audit --no-fund`). Detached; output in
   * `<worktree>/.wavecode-setup.log`; the agent is told when it finishes.
   */
  setup_command?: string;
  /**
   * Glob over remote branch names (without `origin/`) that are release candidates composed by
   * the deployer, e.g. `fable/rc-*`. A lane whose SHA sits in an unreleased candidate is
   * "in candidate": it ships with that release, is not an open fix and is not promoted alone.
   */
  candidate_refs?: string;
}

export interface PeerConfig {
  /** Base URL of the peer daemon, reachable over the tailnet (http://100.x.y.z:3777). */
  url: string;
  /** Bearer token of a user on the peer. Never printed; never the peer's admin token. */
  token: string;
  /** Optional allowlist of remote agent handles (alias or name) that may be asked. */
  agents?: string[];
}

export interface ProfileConfig {
  /** Shared profiles (referee-style service seats) are admin-only. */
  shared?: boolean;
  /**
   * Public profiles are the opposite: agents on them may be used by every
   * user (a pool agent paid by one subscription). Spawning on them stays
   * admin-only; using the agents that exist is open to all.
   */
  public?: boolean;
}

export interface WaveConfig {
  server: {
    port: number;
    host: string;
  };
  paths: {
    projects_root: string;
    worktrees_root: string;
    transcripts_root: string;
    teams_root: string;
    guides_root: string;
    templates_root: string;
    /** Project rooms (spec §5e): `<rooms_root>/<project>/` with SPEC.md, LEDGER.md, REPORTS/ … */
    rooms_root: string;
    /** Extra directories the file viewer may serve (e.g. a shared inbox). Rooms, worktrees, projects, transcripts and artifacts are always included. */
    browse_roots?: string[];
    /** Hand-off folders to watch: a new file is announced to its addressed agent (default ['~/inbox/from-fable']). */
    inbox_watch?: string[];
  };
  /** Per-project verify/referee profiles. Unmatched workspaces keep today's behavior. */
  projects: Record<string, ProjectConfig>;
  autonomy: {
    auto_dispatch: boolean;
    auto_restart: boolean;
    hang_timeout_min: number;
    /**
     * What a quiet "working" pane after hang_timeout_min means. 'alert' (default):
     * agent.hung + notification, nothing killed — an interactive session with a
     * long silent step is not broken, and killing it loses its conversation.
     * 'restart': kill + recreate, but only when a WaveCode run is open on the
     * agent (task-driven work the dispatcher can re-queue).
     */
    hang_action: 'alert' | 'restart';
    max_task_retries: number;
    verify_completion: boolean;
  };
  sandbox: {
    disable_git_push: boolean;
    restrict_network: boolean;
  };
  runtimes: Record<string, RuntimeConfig>;
  /** Root of per-developer credential dirs: `<profiles_root>/<profile>/…` (spec §5). */
  profiles_root: string;
  /** Configured credential profiles. Empty = feature off (agents use the home-dir login). */
  profiles: Record<string, ProfileConfig>;
  /** Default Command Center target: the orchestrator (PM) seat by agent name (spec §5b). */
  orchestrator_agent: string | null;
  /** Nightly retro (spec §5f): each active room's seat proposes template / ROOM.md changes. */
  retro: { nightly: boolean; hour_utc: number; window_days: number };
  auth: {
    method: 'tailscale' | 'token';
    fallback_token: string | null;
    trusted_proxies: string[];
    /**
     * tailscale mode only: a token-less caller on the loopback socket is NOT
     * made owner unless this is true — behind `tailscale serve` or any local
     * proxy every client looks like 127.0.0.1. Prefer token mode.
     */
    allow_loopback_owner?: boolean;
  };
  notifications: {
    web_push: boolean;
    ntfy_topic: string | null;
    telegram_bot_token: string | null;
    telegram_chat_id: string | null;
  };
  artifacts: {
    storage: string;
    retention_days: number;
    /**
     * Drop folders for development fixtures: any file put there (by a person, an agent, or
     * scp from the deploy box) becomes a kept artifact. Sub-folders name the room and the
     * desk (`<inbox>/wavepulse/desk91/invoice.xml`), or the file name carries them.
     */
    fixture_inbox?: string[];
  };
  /**
   * Other WaveCode instances agents may ask questions of (e.g. the deploy
   * box). `token` is a user on THAT instance; scope it there with a profile
   * so it can reach only the answering agent (docs/peers.md).
   */
  peers: Record<string, PeerConfig>;
  review: {
    auto_review: boolean;
    default_reviewer: string;
    self_review: boolean;
    max_fix_loops: number;
    /** Block promote unless the latest completed review verdict is 'pass' (override requires a stored reason). */
    require_pass_to_promote: boolean;
    /** Dependent tasks dispatch only after their dependency's run is human-approved, not merely 'done'. */
    gate_dependents_on_approval: boolean;
    /**
     * Assignment ladder rungs 3–4: with no explicit or configured reviewer,
     * pick a free agent (tag `review` first, other vendor preferred). Off =
     * the run waits with a "needs a reviewer" item until someone picks.
     */
    auto_pick: boolean;
    /**
     * Folders where authors drop freeze notes and reviewers drop verdict files
     * (`*freeze*.md`, `*verdict*.md` with an exact SHA and `VERDICT: PASS|NEEDS FIXES`).
     * Each reviewed SHA becomes a Review-queue card whose Promote relays the GO.
     * Unset = off (a deploy box's inbox holds GO files, not freezes).
     */
    freeze_inbox?: string[];
  };
  /**
   * Releases (src/server/releases.ts). On the deploy box: the agent that receives staging
   * and production requests (alias, name or id). A box without it forwards requests to
   * `projects.<p>.release_peer`.
   */
  releases?: { deploy_agent?: string | null };
  /**
   * The coordinator (src/server/overlord.ts): wakes on board-changing events and a heartbeat,
   * calls `model` on the configured LLM key (llm.anthropic_api_key), posts reports with
   * one-click recommendations. Off unless enabled. It never acts on its own.
   */
  overlord?: {
    enabled?: boolean;
    model?: string;
    heartbeat_min?: number;
    max_wakes_per_hour?: number;
    debounce_s?: number;
    notify?: boolean;
  };
  /** Subscription usage probe: WaveCode types /status (Codex) or /usage (Claude) into one idle agent per profile every N minutes (0 = off). */
  usage?: { probe_interval_min?: number };
  /** Diagram rendering: a self-hosted Kroki (https://kroki.io) for D2 / PlantUML / Graphviz blocks and files. Mermaid renders in the browser. */
  diagrams?: { kroki_url?: string | null };
  llm: {
    provider: 'anthropic' | 'openai-compatible';
    api_key: string | null;
    anthropic_api_key: string | null;
    /** Sent as the anthropic-workspace-id header; required when the key is not scoped to a workspace. */
    anthropic_workspace_id?: string | null;
    openai_api_key: string | null;
    gemini_api_key: string | null;
    perplexity_api_key: string | null;
    xai_api_key: string | null;
    base_url: string | null;
    model: string;
  };
}

let config: WaveConfig | null = null;
let configPath: string | null = null;

export function loadConfig(cfgPath?: string): WaveConfig {
  const resolvedPath = path.resolve(cfgPath ?? path.join(process.cwd(), 'config.yaml'));
  configPath = resolvedPath;
  const configDir = path.dirname(resolvedPath);
  const defaults = buildDefaults(configDir);

  if (!fs.existsSync(resolvedPath)) {
    config = defaults;
    return config;
  }

  const raw = fs.readFileSync(resolvedPath, 'utf-8');
  const parsed = yaml.load(raw) as Partial<WaveConfig> | null;

  const merged = deepMerge(structuredClone(defaults) as unknown as Obj, (parsed ?? {}) as Obj) as unknown as WaveConfig;
  config = normalizeConfigPaths(merged, configDir);
  validateConfig(config);
  return config;
}

/**
 * Validate critical filesystem paths at startup. Fails fast with a clear,
 * actionable error rather than letting the daemon boot and crash on first
 * request. Currently checks that artifacts.storage is creatable and writable.
 */
export function validateConfig(cfg: WaveConfig): void {
  const profileErrors = validateProfilesConfig(cfg);
  if (profileErrors.length > 0) {
    throw new Error(`Invalid credential profile config:\n  ${profileErrors.join('\n  ')}`);
  }
  if (cfg.diagrams?.kroki_url && !/^https?:\/\/[^\s/]+(?::\d+)?\/?$/.test(cfg.diagrams.kroki_url)) {
    throw new Error('diagrams.kroki_url must be an http(s) origin like http://127.0.0.1:8000');
  }
  if (cfg.overlord) {
    const o = cfg.overlord;
    if (o.model !== undefined && (typeof o.model !== 'string' || !/^[\w.-]{3,64}$/.test(o.model))) throw new Error('overlord.model must be a model id like claude-sonnet-5-5');
    for (const k of ['heartbeat_min', 'max_wakes_per_hour', 'debounce_s'] as const) {
      if (o[k] !== undefined && (typeof o[k] !== 'number' || !(o[k]! >= 0))) throw new Error(`overlord.${k} must be a number >= 0`);
    }
  }
  if (cfg.releases?.deploy_agent != null && (typeof cfg.releases.deploy_agent !== 'string' || !/^@?[\w.-]{1,64}$/.test(cfg.releases.deploy_agent))) {
    throw new Error('releases.deploy_agent must be an agent alias, name or id');
  }
  if (cfg.artifacts.fixture_inbox !== undefined) {
    if (!Array.isArray(cfg.artifacts.fixture_inbox) || cfg.artifacts.fixture_inbox.some((d) => typeof d !== 'string' || !d.trim())) {
      throw new Error('artifacts.fixture_inbox must be a list of directory paths');
    }
  }
  if (cfg.review.freeze_inbox !== undefined) {
    if (!Array.isArray(cfg.review.freeze_inbox) || cfg.review.freeze_inbox.some((d) => typeof d !== 'string' || !d.trim())) {
      throw new Error('review.freeze_inbox must be a list of directory paths');
    }
  }
  for (const [name, project] of Object.entries(cfg.projects ?? {})) {
    if (project.release_peer !== undefined) {
      const m = /^([a-z][a-z0-9_-]*)\/(@?[\w.-]+)$/.exec(project.release_peer);
      if (!m) throw new Error(`projects.${name}.release_peer must look like peer/agent (e.g. deploy/fable)`);
      if (!cfg.peers?.[m[1]]) throw new Error(`projects.${name}.release_peer names unknown peer '${m[1]}' (add it under peers:)`);
    }
  }
  for (const [name, peer] of Object.entries(cfg.peers ?? {})) {
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(name)) throw new Error(`peers.${name}: name must be lowercase letters, digits, - or _`);
    if (!peer || typeof peer.url !== 'string' || !/^https?:\/\/[^\s/]+(?::\d+)?\/?$/.test(peer.url)) {
      throw new Error(`peers.${name}.url must be an http(s) origin like http://100.1.2.3:3777`);
    }
    if (typeof peer.token !== 'string' || peer.token.trim().length < 16) throw new Error(`peers.${name}.token is required`);
    if (peer.agents !== undefined && (!Array.isArray(peer.agents) || peer.agents.some((a) => typeof a !== 'string' || !a.trim()))) {
      throw new Error(`peers.${name}.agents must be a list of agent handles`);
    }
  }

  const storageDir = cfg.artifacts.storage;

  try {
    fs.mkdirSync(storageDir, { recursive: true });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    throw new Error(
      `Cannot create artifact storage directory '${storageDir}' (${err.code ?? 'unknown'}): ${err.message}. ` +
      `Update artifacts.storage in config.yaml to a writable path under your home directory.`,
    );
  }

  try {
    fs.accessSync(storageDir, fs.constants.W_OK);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    throw new Error(
      `Artifact storage directory '${storageDir}' exists but is not writable (${err.code ?? 'unknown'}): ${err.message}. ` +
      `Fix permissions or update artifacts.storage in config.yaml.`,
    );
  }
}

export function getConfig(): WaveConfig {
  if (!config) throw new Error('Config not loaded. Call loadConfig() first.');
  return config;
}

/**
 * Get the Anthropic API key — from config first, then env var fallback.
 */
export function getAnthropicApiKey(): string | null {
  const cfg = getConfig();
  return cfg.llm.anthropic_api_key || cfg.llm.api_key || process.env.ANTHROPIC_API_KEY || null;
}

export function getOpenAIApiKey(): string | null {
  const cfg = getConfig();
  return cfg.llm.openai_api_key || process.env.OPENAI_API_KEY || null;
}

export function getGeminiApiKey(): string | null {
  const cfg = getConfig();
  return cfg.llm.gemini_api_key || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || null;
}

export function getPerplexityApiKey(): string | null {
  const cfg = getConfig();
  return cfg.llm.perplexity_api_key || process.env.PERPLEXITY_API_KEY || null;
}

export function getXAIApiKey(): string | null {
  const cfg = getConfig();
  return cfg.llm.xai_api_key || process.env.XAI_API_KEY || null;
}

/**
 * Which research providers have API keys configured.
 * Returns booleans — never expose the keys themselves.
 */
export function getProviderStatus(): Record<string, boolean> {
  return {
    anthropic: !!getAnthropicApiKey(),
    openai: !!getOpenAIApiKey(),
    gemini: !!getGeminiApiKey(),
    perplexity: !!getPerplexityApiKey(),
    xai: !!getXAIApiKey(),
  };
}

/** Top-level keys that are allowed to be updated via the API. */
const ALLOWED_CONFIG_KEYS = new Set<keyof WaveConfig>([
  'server', 'autonomy', 'llm', 'notifications', 'artifacts', 'review',
]);

/**
 * Update config in memory and persist to config.yaml.
 * Only allows known top-level keys to prevent injection of auth/sandbox overrides.
 */
export function updateConfig(updates: Partial<WaveConfig>): WaveConfig {
  if (!config) throw new Error('Config not loaded.');

  // Filter to allowed keys only — blocks auth, sandbox, runtimes overrides from API
  const safeUpdates: Partial<WaveConfig> = {};
  for (const key of Object.keys(updates) as (keyof WaveConfig)[]) {
    if (ALLOWED_CONFIG_KEYS.has(key)) {
      (safeUpdates as Obj)[key] = (updates as Obj)[key];
    }
  }

  // Deep merge into a clone first, then assign (atomic in-memory update)
  const merged = deepMerge(
    structuredClone(config) as unknown as Obj,
    safeUpdates as unknown as Obj,
  ) as unknown as WaveConfig;

  // Persist to file with restricted permissions (contains API keys)
  if (configPath) {
    const yamlStr = yaml.dump(merged, { indent: 2, lineWidth: 120 });
    fs.writeFileSync(configPath, yamlStr, { encoding: 'utf-8', mode: 0o600 });
    // Ensure permissions are correct even if file existed
    fs.chmodSync(configPath, 0o600);
  }

  // Only update in-memory config after successful file write
  config = merged;
  return config;
}

type Obj = Record<string, unknown>;

function buildDefaults(baseDir: string): WaveConfig {
  const dataRoot = path.join(baseDir, '.wavecode-data');

  return {
    server: { port: 3777, host: '0.0.0.0' },
    paths: {
      projects_root: '',
      worktrees_root: path.join(dataRoot, 'worktrees'),
      transcripts_root: path.join(dataRoot, 'transcripts'),
      teams_root: path.join(baseDir, 'teams'),
      guides_root: path.join(baseDir, 'guides'),
      templates_root: path.join(baseDir, 'templates'),
      rooms_root: path.join(dataRoot, 'rooms'),
    },
    autonomy: {
      auto_dispatch: true,
      auto_restart: true,
      hang_timeout_min: 10,
      hang_action: 'alert',
      max_task_retries: 2,
      verify_completion: false,
    },
    sandbox: { disable_git_push: true, restrict_network: true },
    runtimes: {
      'claude-code': {
        command: 'claude --dangerously-skip-permissions',
        idle_pattern: '\\$\\s*$',
        model_flag: '--model',
        resume_args: '--continue',
        env: { CLAUDE_CONFIG_DIR: '{profile_dir}/claude' },
        login_command: 'claude /login',
        credential_files: ['{profile_dir}/claude/.credentials.json'],
      },
      grok: {
        command: 'grok --always-approve',
        idle_pattern: '^>\\s*$',
        model_flag: '--model',
        input_mode: 'type',
        // No profile flag: HOME override for that process only (PATH preserved by `env`)
        env: { HOME: '{profile_dir}/grok-home' },
        login_command: 'grok',
        credential_files: ['{profile_dir}/grok-home/.grok/user-settings.json', '{profile_dir}/grok-home/.grok/auth.json'],
      },
      codex: {
        command: 'codex --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust',
        idle_pattern: '^>\\s*$',
        model_flag: '-m',
        // Current Codex CLI (Rust): `-c model_reasoning_effort=xhigh`.
        // Injector concatenates without a space when the flag ends with `=`.
        effort_flag: '-c model_reasoning_effort=',
        resume_args: 'resume --last',
        env: { CODEX_HOME: '{profile_dir}/codex' },
        login_command: 'codex login',
        credential_files: ['{profile_dir}/codex/auth.json'],
      },
      aider: {
        command: 'aider --yes',
        idle_pattern: '^>\\s*$',
        model_flag: '--model',
      },
    },
    projects: {},
    profiles_root: path.join(dataRoot, 'profiles'),
    profiles: {},
    orchestrator_agent: null,
    peers: {},
    retro: { nightly: true, hour_utc: 3, window_days: 7 },
    auth: { method: 'token', fallback_token: null, trusted_proxies: [] },
    notifications: { web_push: false, ntfy_topic: null, telegram_bot_token: null, telegram_chat_id: null },
    artifacts: { storage: path.join(dataRoot, 'artifacts'), retention_days: 30 },
    review: {
      auto_review: false,
      default_reviewer: 'aider-deepseek',
      self_review: true,
      max_fix_loops: 2,
      require_pass_to_promote: false,
      gate_dependents_on_approval: false,
      auto_pick: true,
    },
    llm: {
      provider: 'anthropic',
      api_key: null,
      anthropic_api_key: null,
      anthropic_workspace_id: null,
      openai_api_key: null,
      gemini_api_key: null,
      perplexity_api_key: null,
      xai_api_key: null,
      base_url: null,
      model: 'claude-sonnet-4-20250514',
    },
  };
}

function normalizeConfigPaths(cfg: WaveConfig, baseDir: string): WaveConfig {
  const normalized = structuredClone(cfg);

  normalized.paths.projects_root = normalizePathSetting(normalized.paths.projects_root, baseDir, { allowEmpty: true });
  normalized.paths.worktrees_root = normalizePathSetting(normalized.paths.worktrees_root, baseDir);
  normalized.paths.transcripts_root = normalizePathSetting(normalized.paths.transcripts_root, baseDir);
  normalized.paths.teams_root = normalizePathSetting(normalized.paths.teams_root, baseDir);
  normalized.paths.guides_root = normalizePathSetting(normalized.paths.guides_root, baseDir);
  normalized.paths.templates_root = normalizePathSetting(normalized.paths.templates_root, baseDir);
  normalized.paths.rooms_root = normalizePathSetting(normalized.paths.rooms_root, baseDir);
  normalized.artifacts.storage = normalizePathSetting(normalized.artifacts.storage, baseDir);
  normalized.profiles_root = normalizePathSetting(normalized.profiles_root, baseDir);
  normalized.profiles = normalized.profiles ?? {};

  return normalized;
}

function normalizePathSetting(value: string, baseDir: string, opts: { allowEmpty?: boolean } = {}): string {
  if (!value) return opts.allowEmpty ? '' : baseDir;

  const expanded = expandHomeDir(value);
  return path.isAbsolute(expanded) ? expanded : path.resolve(baseDir, expanded);
}

function expandHomeDir(value: string): string {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function deepMerge(target: Obj, source: Obj): Obj {
  for (const key of Object.keys(source)) {
    const targetVal = target[key];
    const sourceVal = source[key];
    if (
      targetVal && sourceVal &&
      typeof targetVal === 'object' && typeof sourceVal === 'object' &&
      !Array.isArray(targetVal) && !Array.isArray(sourceVal)
    ) {
      target[key] = deepMerge(targetVal as Obj, sourceVal as Obj);
    } else {
      target[key] = sourceVal;
    }
  }
  return target;
}
