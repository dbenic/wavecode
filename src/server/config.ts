import fs from 'node:fs';
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

const DEFAULT_DATA_ROOT = path.join(process.cwd(), '.wavecode-data');

const DEFAULTS: WaveConfig = {
  server: { port: 3777, host: '0.0.0.0' },
  paths: {
    projects_root: '',
    worktrees_root: path.join(DEFAULT_DATA_ROOT, 'worktrees'),
    transcripts_root: path.join(DEFAULT_DATA_ROOT, 'transcripts'),
    teams_root: path.join(process.cwd(), 'teams'),
    guides_root: path.join(process.cwd(), 'guides'),
    templates_root: path.join(process.cwd(), 'templates'),
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
  auth: { method: 'tailscale', fallback_token: null, trusted_proxies: [] },
  notifications: { web_push: false, ntfy_topic: null, telegram_bot_token: null, telegram_chat_id: null },
  artifacts: { storage: path.join(DEFAULT_DATA_ROOT, 'artifacts'), retention_days: 30 },
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

let config: WaveConfig | null = null;
let configPath: string | null = null;

export function loadConfig(cfgPath?: string): WaveConfig {
  const resolvedPath = cfgPath ?? path.join(process.cwd(), 'config.yaml');
  configPath = resolvedPath;

  if (!fs.existsSync(resolvedPath)) {
    config = structuredClone(DEFAULTS);
    return config;
  }

  const raw = fs.readFileSync(resolvedPath, 'utf-8');
  const parsed = yaml.load(raw) as Partial<WaveConfig> | null;

  config = deepMerge(structuredClone(DEFAULTS) as unknown as Obj, (parsed ?? {}) as Obj) as unknown as WaveConfig;
  return config;
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
