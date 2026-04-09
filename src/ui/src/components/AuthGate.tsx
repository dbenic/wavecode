import { useState } from 'react';
import { clearAccessToken, useAuthState, verifyAccessToken } from '../hooks/useApi';

export default function AuthGate() {
  const auth = useAuthState();
  const [token, setToken] = useState(auth.token ?? '');
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleVerify = async () => {
    if (!token.trim() || verifying) return;

    setVerifying(true);
    setError(null);

    try {
      await verifyAccessToken(token.trim());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setVerifying(false);
    }
  };

  const handleClear = () => {
    clearAccessToken();
    setToken('');
    setError(null);
  };

  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center px-4">
      <div className="w-full max-w-md rounded-xl border border-slate-800/60 bg-slate-900/90 p-6 space-y-4 shadow-2xl">
        <div className="space-y-1">
          <p className="text-[10px] text-slate-500 tracking-[0.3em] uppercase">Authentication</p>
          <h1 className="text-xl font-semibold text-slate-100">Access token required</h1>
          <p className="text-sm text-slate-500">
            Enter the WaveCode access token to unlock the operator UI.
          </p>
        </div>

        {!auth.tokenConfigured && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-950/20 px-3 py-2 text-sm text-amber-300">
            Token auth is enabled on the server, but no fallback token is configured.
          </div>
        )}

        {auth.unauthorized && auth.token && (
          <div className="rounded-lg border border-red-500/30 bg-red-950/20 px-3 py-2 text-sm text-red-300">
            The stored access token was rejected by the server.
          </div>
        )}

        <div className="space-y-2">
          <label className="block text-[10px] font-bold tracking-wider text-slate-400 uppercase">
            Access Token
          </label>
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="Bearer token"
            className="w-full px-3 py-2 rounded-lg border-2 border-slate-700/60 bg-slate-800/80 text-sm text-slate-100 font-mono placeholder:text-slate-600 focus:outline-none focus:border-emerald-400/60"
          />
        </div>

        {error && (
          <div className="rounded-lg border border-red-500/30 bg-red-950/20 px-3 py-2 text-sm text-red-300">
            {error}
          </div>
        )}

        <div className="flex items-center gap-2">
          <button
            onClick={handleVerify}
            disabled={!token.trim() || verifying || !auth.tokenConfigured}
            className={`flex-1 px-4 py-2 rounded-lg border text-[11px] font-bold tracking-wider transition-all ${
              !token.trim() || verifying || !auth.tokenConfigured
                ? 'bg-slate-900 border-slate-800 text-slate-600 cursor-not-allowed'
                : 'bg-emerald-950 border-emerald-500/50 text-emerald-300 hover:bg-emerald-900 active:scale-95'
            }`}
          >
            {verifying ? 'VERIFYING...' : 'UNLOCK'}
          </button>
          <button
            onClick={handleClear}
            className="px-4 py-2 rounded-lg border border-slate-700/60 text-[11px] font-bold tracking-wider text-slate-300 hover:border-slate-600 hover:text-slate-100 transition-all"
          >
            CLEAR
          </button>
        </div>
      </div>
    </div>
  );
}
