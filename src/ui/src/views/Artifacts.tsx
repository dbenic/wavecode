import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiGet, apiPost, apiUpload } from '../hooks/useApi';
import { useSSE, type SSEEvent } from '../hooks/useSSE';
import type { Agent, Artifact } from '../types';
import ArtifactThumbnail from '../components/ArtifactThumbnail';

export default function Artifacts() {
  const navigate = useNavigate();
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [filterAgent, setFilterAgent] = useState('');
  const [filterType, setFilterType] = useState('');
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchData = useCallback(() => {
    Promise.all([
      apiGet<Artifact[]>('/artifacts'),
      apiGet<Agent[]>('/agents'),
    ]).then(([a, ag]) => {
      setArtifacts(a);
      setAgents(ag);
      setLoaded(true);
    }).catch(() => setLoaded(true));
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleSSE = useCallback((event: SSEEvent) => {
    if (event.type === 'artifact.created' || event.type === 'artifact.shared') {
      fetchData();
    }
    if (event.type === 'artifact.deleted') {
      setArtifacts((prev) => prev.filter((a) => a.id !== event.entityId));
    }
  }, [fetchData]);

  useSSE(handleSSE);

  const agentMap = new Map(agents.map((a) => [a.id, a]));

  // Upload handler
  const uploadFile = async (file: File) => {
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      await apiUpload('/artifacts/upload', formData);
      fetchData();
    } catch {
      // upload failed
    } finally {
      setUploading(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) uploadFile(file);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) uploadFile(file);
  };

  // Filter
  let filtered = artifacts;
  if (filterAgent) {
    filtered = filtered.filter((a) => a.source_agent_id === filterAgent);
  }
  if (filterType) {
    if (filterType === 'text') filtered = filtered.filter((a) => a.mime_type.startsWith('text/'));
    else if (filterType === 'image') filtered = filtered.filter((a) => a.mime_type.startsWith('image/'));
    else filtered = filtered.filter((a) => !a.mime_type.startsWith('text/') && !a.mime_type.startsWith('image/'));
  }

  return (
    <div className="min-h-screen bg-slate-950 relative">
      {/* Scan-line */}
      <div
        className="pointer-events-none fixed inset-0 z-50 opacity-[0.015]"
        style={{
          backgroundImage:
            'repeating-linear-gradient(0deg, transparent, transparent 3px, rgba(255,255,255,0.03) 3px, rgba(255,255,255,0.03) 6px)',
        }}
      />

      {/* Header */}
      <header className="sticky top-0 z-40 border-b border-slate-800/60 bg-slate-950/90 backdrop-blur-xl">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button onClick={() => navigate('/')} className="text-slate-500 hover:text-slate-300 transition-colors text-sm">
              &larr;
            </button>
            <div>
              <h1 className="text-sm font-bold tracking-[0.15em] text-slate-100 uppercase">
                Artifacts
              </h1>
              <p className="text-[9px] text-slate-600 tracking-[0.3em] uppercase">
                {artifacts.length} file{artifacts.length !== 1 ? 's' : ''} &middot; Immutable Store
              </p>
            </div>
          </div>

          {/* Filters */}
          <div className="flex items-center gap-2">
            <select
              value={filterAgent}
              onChange={(e) => setFilterAgent(e.target.value)}
              className="px-2 py-1 rounded border border-slate-800/60 bg-slate-950/50 text-[10px] text-slate-400 font-mono focus:outline-none focus:border-slate-600"
            >
              <option value="">All agents</option>
              {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
            <select
              value={filterType}
              onChange={(e) => setFilterType(e.target.value)}
              className="px-2 py-1 rounded border border-slate-800/60 bg-slate-950/50 text-[10px] text-slate-400 font-mono focus:outline-none focus:border-slate-600"
            >
              <option value="">All types</option>
              <option value="text">Text</option>
              <option value="image">Images</option>
              <option value="other">Other</option>
            </select>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-6 space-y-6">
        {/* Upload zone */}
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          className={`
            rounded-lg border-2 border-dashed cursor-pointer
            transition-all duration-200 py-6 text-center
            ${dragOver
              ? 'border-emerald-500/50 bg-emerald-500/5'
              : 'border-slate-800/40 hover:border-slate-700/60 bg-slate-900/20'
            }
          `}
        >
          <input
            ref={fileInputRef}
            type="file"
            onChange={handleFileSelect}
            className="hidden"
          />
          <div className="text-slate-600">
            {uploading ? (
              <span className="text-[11px] tracking-wider animate-pulse">UPLOADING...</span>
            ) : (
              <>
                <span className="text-lg block mb-1">+</span>
                <span className="text-[10px] tracking-wider">
                  DROP FILE OR CLICK TO UPLOAD
                </span>
              </>
            )}
          </div>
        </div>

        {/* Artifacts grid */}
        {!loaded ? (
          <div className="flex items-center justify-center py-16">
            <div className="text-[10px] text-slate-600 tracking-[0.3em] uppercase animate-pulse">
              Loading artifacts...
            </div>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 gap-3">
            <span className="text-2xl text-slate-800">~</span>
            <p className="text-[11px] text-slate-600">
              {artifacts.length === 0 ? 'No artifacts yet' : 'No matches for current filters'}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {filtered.map((artifact, i) => (
              <ArtifactThumbnail
                key={artifact.id}
                artifact={artifact}
                agentName={artifact.source_agent_id ? agentMap.get(artifact.source_agent_id)?.name : undefined}
                agents={agents}
                index={i}
                onDelete={(id) => setArtifacts((prev) => prev.filter((a) => a.id !== id))}
              />
            ))}
          </div>
        )}
      </main>

      <style>{`
        @keyframes artifactIn {
          from { opacity: 0; transform: translateY(8px) scale(0.98); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
      `}</style>
    </div>
  );
}
