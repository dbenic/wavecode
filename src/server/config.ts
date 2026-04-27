import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';

export interface RuntimeConfig {
  command: string;
  idle_pattern: string;
  // Future deploy agent fields (optional)
  scope?: string;
  claude_md?: string;
  workspace?: string;
  ssh_key?: string;
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
  };
  autonomy: {
    auto_dispatch: boolean;
    auto_restart: boolean;
    hang_timeout_min: number;
    max_task_retries: number;
    verify_completion: boolean;
  };
  sandbox: {
    disable_git_push: boolean;
    restrict_network: boolean;
  };
  runtimes: Record<string, RuntimeConfig>;
  auth: {
    method: 'tailscale' | 'token';
    fallback_token: string | null;
    trusted_proxies: string[];
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
  };
  review: {
    auto_review: boolean;
    default_reviewer: string;
    self_review: boolean;
    max_fix_loops: number;
  };
  llm: {
    provider: 'anthropic' | 'openai-compatible';
    api_key: string | null;
    anthropic_api_key: string | null;
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
    },
    autonomy: {
      auto_dispatch: true,
      auto_restart: true,
      hang_timeout_min: 10,
      max_task_retries: 2,
      verify_completion: false,
    },
    sandbox: { disable_git_push: true, restrict_network: true },
    runtimes: {
      'claude-code': {
        command: 'claude --permission-mode bypassPermissions',
        idle_pattern: '\\$\\s*$',
      },
      codex: {
        command: 'codex --full-auto',
        idle_pattern: '^>\\s*$',
      },
      aider: {
        command: 'aider --yes',
        idle_pattern: '^>\\s*$',
      },
    },
    auth: { method: 'token', fallback_token: null, trusted_proxies: [] },
    notifications: { web_push: false, ntfy_topic: null, telegram_bot_token: null, telegram_chat_id: null },
    artifacts: { storage: path.join(dataRoot, 'artifacts'), retention_days: 30 },
    review: { auto_review: false, default_reviewer: 'aider-deepseek', self_review: true, max_fix_loops: 2 },
    llm: {
      provider: 'anthropic',
      api_key: null,
      anthropic_api_key: null,
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
  normalized.artifacts.storage = normalizePathSetting(normalized.artifacts.storage, baseDir);

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
