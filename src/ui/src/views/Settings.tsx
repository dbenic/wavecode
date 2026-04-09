import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiGet, apiPut } from '../hooks/useApi';

interface SettingsData {
  server: { port: number; host: string };
  paths: { worktrees_root: string; transcripts_root: string; teams_root: string };
  auth: { method: string; tokenConfigured: boolean };
  autonomy: { auto_dispatch: boolean; auto_restart: boolean; hang_timeout_min: number; max_task_retries: number };
  llm: {
    provider: string;
    api_key: string | null;
    has_key: boolean;
    configured: boolean;
    base_url: string | null;
    model: string;
    anthropic_api_key: string | null;
    openai_api_key: string | null;
    gemini_api_key: string | null;
    perplexity_api_key: string | null;
    xai_api_key: string | null;
  };
  notifications: { web_push: boolean; ntfy_topic: string | null; telegram_bot_token: string | null };
  artifacts: { storage: string; retention_days: number };
  runtimes: string[];
}

interface ProviderStatus {
  anthropic: boolean;
  openai: boolean;
  gemini: boolean;
  perplexity: boolean;
  xai: boolean;
}

const RESEARCH_PROVIDERS = [
  { key: 'anthropic_api_key', label: 'Anthropic', placeholder: 'sk-ant-...', statusKey: 'anthropic' as const },
  { key: 'openai_api_key', label: 'OpenAI', placeholder: 'sk-...', statusKey: 'openai' as const },
  { key: 'gemini_api_key', label: 'Google Gemini', placeholder: 'AIza...', statusKey: 'gemini' as const },
  { key: 'perplexity_api_key', label: 'Perplexity', placeholder: 'pplx-...', statusKey: 'perplexity' as const },
  { key: 'xai_api_key', label: 'xAI (Grok)', placeholder: 'xai-...', statusKey: 'xai' as const },
] as const;

export default function Settings() {
  const navigate = useNavigate();
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [providers, setProviders] = useState<ProviderStatus | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [provider, setProvider] = useState('anthropic');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [providerKeys, setProviderKeys] = useState<Record<string, string>>({});
  const [providerSaving, setProviderSaving] = useState<string | null>(null);
  const [providerSaved, setProviderSaved] = useState<string | null>(null);
  const [showRawConfig, setShowRawConfig] = useState(false);

  const refreshSettings = async () => {
    const data = await apiGet<SettingsData>('/settings');
    setSettings(data);
    setProvider(data.llm.provider);
    setBaseUrl(data.llm.base_url ?? '');
    setModel(data.llm.model);
    return data;
  };

  useEffect(() => {
    refreshSettings().catch(() => {});
    apiGet<ProviderStatus>('/providers').then(setProviders).catch(() => {});
  }, []);

  const handleSaveKey = async () => {
    if (!apiKey.trim()) return;
    setSaving(true);
    try {
      await apiPut('/settings/api-key', { key: apiKey, provider });
      setSaved(true);
      setApiKey('');
      await refreshSettings();
      apiGet<ProviderStatus>('/providers').then(setProviders).catch(() => {});
      setTimeout(() => setSaved(false), 3000);
    } catch {
      // Error shown via global ErrorBanner
    } finally { setSaving(false); }
  };

  const handleSaveModel = async () => {
    setSaving(true);
    try {
      await apiPut('/settings', {
        llm: {
          provider,
          base_url: provider === 'openai-compatible' ? (baseUrl.trim() || null) : null,
          model,
        },
      });
      setSaved(true);
      await refreshSettings();
      setTimeout(() => setSaved(false), 3000);
    } catch {
      // Error shown via global ErrorBanner
    } finally { setSaving(false); }
  };

  const handleSaveProviderKey = async (providerKey: string) => {
    const value = providerKeys[providerKey]?.trim();
    if (!value) return;
    setProviderSaving(providerKey);
    try {
      await apiPut('/settings', {
        llm: { [providerKey]: value },
      });
      setProviderSaved(providerKey);
      setProviderKeys((prev) => ({ ...prev, [providerKey]: '' }));
      await refreshSettings();
      apiGet<ProviderStatus>('/providers').then(setProviders).catch(() => {});
      setTimeout(() => setProviderSaved(null), 3000);
    } catch {
      // Error shown via global ErrorBanner
    } finally { setProviderSaving(null); }
  };

  return (
    <div className="min-h-screen bg-slate-950">
      <header className="sticky top-0 z-40 border-b border-slate-800/60 bg-slate-950/90 backdrop-blur-xl">
        <div className="max-w-2xl mx-auto px-4 py-3 flex items-center gap-3">
          <button onClick={() => navigate('/')} className="text-slate-500 hover:text-slate-300 transition-colors text-sm">&larr;</button>
          <h1 className="text-sm font-bold tracking-[0.15em] text-slate-100 uppercase">Settings</h1>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-6 space-y-6">
        {/* LLM Configuration */}
        <section className="rounded-lg border border-slate-800/50 bg-slate-900/50 overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-800/30">
            <h2 className="text-xs font-bold tracking-[0.2em] text-slate-300 uppercase">LLM Configuration</h2>
            <p className="text-[10px] text-slate-500 mt-0.5">Powers the Command Chat and Prompt Enhancer</p>
          </div>
          <div className="p-4 space-y-4">
            <div>
              <label htmlFor="llm-provider" className="block text-[10px] font-bold tracking-wider text-slate-400 uppercase mb-1.5">Provider</label>
              <select
                id="llm-provider"
                value={provider}
                onChange={(e) => setProvider(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border-2 border-slate-700/60 bg-slate-800/80 text-sm text-slate-100 font-mono focus:outline-none focus:border-emerald-400/60"
              >
                <option value="anthropic">Anthropic</option>
                <option value="openai-compatible">OpenAI-compatible</option>
              </select>
              <p className="text-[10px] text-slate-500 mt-1.5">
                Use Anthropic directly, or point the manager at a local/OpenAI-compatible endpoint for models like Gemma.
              </p>
            </div>

            {/* API Key */}
            <div>
              <label htmlFor="llm-api-key" className="block text-[10px] font-bold tracking-wider text-slate-400 uppercase mb-1.5">
                {provider === 'anthropic' ? 'Anthropic API Key' : 'API Key'}
              </label>
              <div className="flex gap-2">
                <input
                  id="llm-api-key"
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={
                    settings?.llm.has_key
                      ? 'Key configured - enter new key to replace'
                      : provider === 'anthropic'
                        ? 'sk-ant-...'
                        : 'sk-... (optional for local endpoints)'
                  }
                  className="flex-1 px-3 py-2 rounded-lg border-2 border-slate-700/60 bg-slate-800/80 text-sm text-slate-100 font-mono placeholder:text-slate-600 focus:outline-none focus:border-emerald-400/60"
                />
                <button
                  onClick={handleSaveKey}
                  disabled={saving || !apiKey.trim()}
                  className={`px-4 py-2 rounded-lg border text-[11px] font-bold tracking-wider transition-all
                    ${saving || !apiKey.trim()
                      ? 'bg-slate-900 border-slate-800 text-slate-600 cursor-not-allowed'
                      : 'bg-emerald-950 border-emerald-500/50 text-emerald-300 hover:bg-emerald-900 active:scale-95'}`}
                >
                  {saving ? '...' : 'SAVE'}
                </button>
              </div>
              {settings?.llm.has_key && (
                <p className="text-[10px] text-emerald-400 mt-1.5">✓ API key configured</p>
              )}
              {!settings?.llm.has_key && provider === 'openai-compatible' && (
                <p className="text-[10px] text-slate-500 mt-1.5">Optional when your local endpoint does not require auth.</p>
              )}
              {saved && <p className="text-[10px] text-emerald-400 mt-1.5">✓ Saved successfully</p>}
            </div>

            {provider === 'openai-compatible' && (
              <div>
                <label htmlFor="llm-base-url" className="block text-[10px] font-bold tracking-wider text-slate-400 uppercase mb-1.5">Base URL</label>
                <input
                  id="llm-base-url"
                  type="text"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="http://127.0.0.1:11434/v1"
                  className="w-full px-3 py-2 rounded-lg border-2 border-slate-700/60 bg-slate-800/80 text-sm text-slate-100 font-mono placeholder:text-slate-600 focus:outline-none focus:border-emerald-400/60"
                />
                <p className="text-[10px] text-slate-500 mt-1.5">
                  Leave this blank only if you want to target the default OpenAI-compatible cloud endpoint with an API key.
                </p>
              </div>
            )}

            {/* Model */}
            <div>
              <label htmlFor="llm-model" className="block text-[10px] font-bold tracking-wider text-slate-400 uppercase mb-1.5">Model</label>
              <div className="flex gap-2">
                <input
                  id="llm-model"
                  type="text"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder={provider === 'anthropic' ? 'claude-sonnet-4-20250514' : 'gpt-5-codex or gemma4'}
                  className="flex-1 px-3 py-2 rounded-lg border-2 border-slate-700/60 bg-slate-800/80 text-sm text-slate-100 font-mono focus:outline-none focus:border-emerald-400/60"
                />
                <button
                  onClick={handleSaveModel}
                  disabled={saving}
                  className="px-4 py-2 rounded-lg border bg-slate-800 border-slate-600/50 text-[11px] font-bold tracking-wider text-slate-300 hover:bg-slate-700 active:scale-95 transition-all"
                >
                  SAVE
                </button>
              </div>
              <p className="text-[10px] text-slate-500 mt-1.5">
                Free-form Command Chat needs a model that supports tool calling. Explicit chat commands still work without it.
              </p>
              {settings?.llm.configured && (
                <p className="text-[10px] text-emerald-400 mt-1.5">✓ Provider endpoint configured</p>
              )}
            </div>
          </div>
        </section>

        {/* Research Providers */}
        <section className="rounded-lg border border-slate-800/50 bg-slate-900/50 overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-800/30">
            <h2 className="text-xs font-bold tracking-[0.2em] text-slate-300 uppercase">Research Providers</h2>
            <p className="text-[10px] text-slate-500 mt-0.5">API keys for Specs research — each enables a model family in the Specs view</p>
          </div>
          <div className="p-4 space-y-3">
            {RESEARCH_PROVIDERS.map((rp) => {
              const configured = providers?.[rp.statusKey] ?? false;
              const inputValue = providerKeys[rp.key] ?? '';
              const isSaving = providerSaving === rp.key;
              const justSaved = providerSaved === rp.key;
              return (
                <div key={rp.key} className="flex items-center gap-2">
                  <div className="w-24 shrink-0 flex items-center gap-1.5">
                    <span className={`w-1.5 h-1.5 rounded-full ${configured ? 'bg-emerald-400' : 'bg-slate-700'}`} />
                    <span className="text-[10px] font-bold tracking-wider text-slate-400 uppercase">{rp.label}</span>
                  </div>
                  <input
                    type="password"
                    value={inputValue}
                    onChange={(e) => setProviderKeys((prev) => ({ ...prev, [rp.key]: e.target.value }))}
                    placeholder={configured ? 'Key configured — enter new to replace' : rp.placeholder}
                    className="flex-1 px-2.5 py-1.5 rounded-lg border border-slate-700/60 bg-slate-800/80 text-xs text-slate-100 font-mono placeholder:text-slate-600 focus:outline-none focus:border-emerald-400/60"
                  />
                  <button
                    onClick={() => handleSaveProviderKey(rp.key)}
                    disabled={isSaving || !inputValue.trim()}
                    className={`px-3 py-1.5 rounded-lg border text-[10px] font-bold tracking-wider transition-all shrink-0
                      ${isSaving || !inputValue.trim()
                        ? 'bg-slate-900 border-slate-800 text-slate-600 cursor-not-allowed'
                        : 'bg-emerald-950 border-emerald-500/50 text-emerald-300 hover:bg-emerald-900 active:scale-95'}`}
                  >
                    {isSaving ? '...' : justSaved ? '✓' : 'SAVE'}
                  </button>
                </div>
              );
            })}
          </div>
        </section>

        {/* Advanced: Raw Config */}
        <section className="rounded-lg border border-slate-800/50 bg-slate-900/50 overflow-hidden">
          <button
            onClick={() => setShowRawConfig(!showRawConfig)}
            className="w-full px-4 py-3 flex items-center justify-between hover:bg-slate-800/30 transition-colors"
          >
            <h2 className="text-xs font-bold tracking-[0.2em] text-slate-300 uppercase">Advanced</h2>
            <span className="text-slate-500 text-xs">{showRawConfig ? '▲' : '▼'}</span>
          </button>
          {showRawConfig && settings && (
            <div className="px-4 pb-4">
              <p className="text-[10px] text-slate-500 mb-2">Read-only view of current configuration. Edit config.yaml on the server for advanced changes.</p>
              <pre className="p-3 rounded-lg bg-slate-950 border border-slate-800/50 text-[10px] font-mono text-slate-400 overflow-x-auto max-h-80 overflow-y-auto whitespace-pre-wrap">
                {JSON.stringify(settings, null, 2)}
              </pre>
            </div>
          )}
        </section>

        {/* System Info */}
        <section className="rounded-lg border border-slate-800/50 bg-slate-900/50 overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-800/30">
            <h2 className="text-xs font-bold tracking-[0.2em] text-slate-300 uppercase">System</h2>
          </div>
          <div className="p-4 space-y-2 text-[11px] font-mono text-slate-400">
            {settings && (
              <>
                <div className="flex justify-between"><span className="text-slate-500">Server</span><span>{settings.server.host}:{settings.server.port}</span></div>
                <div className="flex justify-between"><span className="text-slate-500">Auth</span><span>{settings.auth.method}</span></div>
                <div className="flex justify-between"><span className="text-slate-500">Auto Dispatch</span><span className={settings.autonomy.auto_dispatch ? 'text-emerald-400' : 'text-slate-600'}>{settings.autonomy.auto_dispatch ? 'ON' : 'OFF'}</span></div>
                <div className="flex justify-between"><span className="text-slate-500">Auto Restart</span><span className={settings.autonomy.auto_restart ? 'text-emerald-400' : 'text-slate-600'}>{settings.autonomy.auto_restart ? 'ON' : 'OFF'}</span></div>
                <div className="flex justify-between"><span className="text-slate-500">Hang Timeout</span><span>{settings.autonomy.hang_timeout_min}m</span></div>
                <div className="flex justify-between"><span className="text-slate-500">Max Retries</span><span>{settings.autonomy.max_task_retries}</span></div>
                <div className="flex justify-between"><span className="text-slate-500">Runtimes</span><span>{settings.runtimes.join(', ')}</span></div>
                <div className="flex justify-between"><span className="text-slate-500">Artifacts</span><span>{settings.artifacts.storage}</span></div>
                <div className="flex justify-between"><span className="text-slate-500">Worktrees</span><span>{settings.paths.worktrees_root}</span></div>
                <div className="flex justify-between"><span className="text-slate-500">Transcripts</span><span>{settings.paths.transcripts_root}</span></div>
              </>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
