import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiGet, apiPost, apiUpload } from '../hooks/useApi';
import { useSSE, type SSEEvent } from '../hooks/useSSE';
import type { Agent, Artifact } from '../types';
import ArtifactThumbnail from '../components/ArtifactThumbnail';

type View = 'fixtures' | 'all';

interface PeerInfo { name: string; url: string }
interface PeerFixture {
  id: string; filename: string; mime_type: string; size_bytes: number; sha256: string;
  desk: string | null; room: string | null; provenance: string | null; note: string | null; created_at: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

const field = 'px-2 py-1 rounded border border-slate-800/60 bg-slate-950/50 text-[10px] text-slate-300 font-mono focus:outline-none focus:border-slate-600';

/**
 * The development library. Fixtures are kept files (never pruned) with a desk
 * reference, a room and a provenance line; everything else is transient. Files
 * arrive by upload here, by drop folder, or by import from the production peer.
 */
export default function Artifacts() {
  const navigate = useNavigate();
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [rooms, setRooms] = useState<string[]>([]);
  const [peers, setPeers] = useState<PeerInfo[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [view, setView] = useState<View>('fixtures');
  const [q, setQ] = useState('');
  const [filterRoom, setFilterRoom] = useState('');
  const [filterAgent, setFilterAgent] = useState('');
  const [filterType, setFilterType] = useState('');
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // upload form (library fields)
  const [keep, setKeep] = useState(true);
  const [desk, setDesk] = useState('');
  const [room, setRoom] = useState('');
  const [provenance, setProvenance] = useState('');

  // import from a peer
  const [importPeer, setImportPeer] = useState('');
  const [peerFixtures, setPeerFixtures] = useState<PeerFixture[] | null>(null);
  const [peerError, setPeerError] = useState<string | null>(null);
  const [importing, setImporting] = useState<string | null>(null);

  const fetchData = useCallback(() => {
    const params = new URLSearchParams();
    if (view === 'fixtures') params.set('kind', 'fixture');
    if (q.trim()) params.set('q', q.trim());
    if (filterRoom) params.set('room', filterRoom);
    apiGet<Artifact[]>('/artifacts' + (params.toString() ? `?${params}` : ''))
      .then((a) => { setArtifacts(a); setLoaded(true); })
      .catch(() => setLoaded(true));
  }, [view, q, filterRoom]);

  useEffect(() => { fetchData(); }, [fetchData]);

  useEffect(() => {
    apiGet<Agent[]>('/agents').then(setAgents).catch(() => setAgents([]));
    apiGet<Array<{ project?: string; id?: string } | string>>('/rooms')
      .then((rs) => setRooms(rs.map((r) => (typeof r === 'string' ? r : r.project ?? r.id ?? '')).filter(Boolean)))
      .catch(() => setRooms([]));
    apiGet<PeerInfo[]>('/peers').then(setPeers).catch(() => setPeers([]));
  }, []);

  const handleSSE = useCallback((event: SSEEvent) => {
    if (event.type === 'artifact.created' || event.type === 'artifact.shared' || event.type === 'artifact.updated') {
      fetchData();
    }
    if (event.type === 'artifact.deleted') {
      setArtifacts((prev) => prev.filter((a) => a.id !== event.entityId));
    }
  }, [fetchData]);

  useSSE(handleSSE);

  const agentMap = new Map(agents.map((a) => [a.id, a]));

  const uploadFiles = async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (list.length === 0) return;
    setUploading(true);
    try {
      for (const file of list) {
        const formData = new FormData();
        formData.append('file', file);
        if (keep) {
          formData.append('kind', 'fixture');
          if (desk.trim()) formData.append('desk', desk.trim());
          if (room) formData.append('room', room);
          if (provenance.trim()) formData.append('provenance', provenance.trim());
        }
        await apiUpload('/artifacts/upload', formData);
      }
      fetchData();
    } catch {
      // upload failed; the error banner already reported it
    } finally {
      setUploading(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    uploadFiles(e.dataTransfer.files);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) uploadFiles(e.target.files);
    e.target.value = '';
  };

  const loadPeerFixtures = async (peer: string) => {
    setImportPeer(peer);
    setPeerFixtures(null);
    setPeerError(null);
    if (!peer) return;
    try {
      setPeerFixtures(await apiGet<PeerFixture[]>(`/peers/${encodeURIComponent(peer)}/artifacts`));
    } catch (e) {
      setPeerError((e as Error).message || 'peer unreachable');
      setPeerFixtures([]);
    }
  };

  const importFixture = async (f: PeerFixture) => {
    setImporting(f.id);
    try {
      await apiPost(`/peers/${encodeURIComponent(importPeer)}/artifacts/${encodeURIComponent(f.id)}/import`, {
        ...(room ? { room } : {}),
      });
      fetchData();
    } catch {
      // reported by the error banner
    } finally {
      setImporting(null);
    }
  };

  // client-side narrowing on top of the server filters
  let filtered = artifacts;
  if (filterAgent) filtered = filtered.filter((a) => a.source_agent_id === filterAgent);
  if (filterType) {
    if (filterType === 'text') filtered = filtered.filter((a) => a.mime_type.startsWith('text/'));
    else if (filterType === 'image') filtered = filtered.filter((a) => a.mime_type.startsWith('image/'));
    else filtered = filtered.filter((a) => !a.mime_type.startsWith('text/') && !a.mime_type.startsWith('image/'));
  }

  const fixtureCount = artifacts.filter((a) => a.kind === 'fixture').length;
  const importedIds = new Set(artifacts.map((a) => a.sha256));

  return (
    <div className="min-h-screen bg-slate-950 relative">
      <div
        className="pointer-events-none fixed inset-0 z-50 opacity-[0.015]"
        style={{ backgroundImage: 'repeating-linear-gradient(0deg, transparent, transparent 3px, rgba(255,255,255,0.03) 3px, rgba(255,255,255,0.03) 6px)' }}
      />

      <header className="sticky top-0 z-40 border-b border-slate-800/60 bg-slate-950/90 backdrop-blur-xl">
        <div className="max-w-5xl mx-auto px-4 py-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-3">
            <button onClick={() => navigate('/')} className="text-slate-500 hover:text-slate-300 transition-colors text-sm">&larr;</button>
            <div>
              <h1 className="text-sm font-bold tracking-[0.15em] text-slate-100 uppercase">Library</h1>
              <p className="text-[9px] text-slate-600 tracking-[0.3em] uppercase">
                {view === 'fixtures' ? `${fixtureCount} fixture${fixtureCount !== 1 ? 's' : ''}` : `${artifacts.length} file${artifacts.length !== 1 ? 's' : ''}`} &middot; Immutable Store
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="flex rounded border border-slate-800/60 overflow-hidden text-[10px] font-semibold tracking-wider">
              <button onClick={() => setView('fixtures')} className={`px-2.5 py-1 ${view === 'fixtures' ? 'bg-violet-500/15 text-violet-300' : 'text-slate-500 hover:text-slate-300'}`}>FIXTURES</button>
              <button onClick={() => setView('all')} className={`px-2.5 py-1 ${view === 'all' ? 'bg-slate-700/40 text-slate-200' : 'text-slate-500 hover:text-slate-300'}`}>ALL</button>
            </div>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="search name, desk, note…"
              className={`${field} w-44`}
              aria-label="Search"
            />
            <select value={filterRoom} onChange={(e) => setFilterRoom(e.target.value)} className={field} aria-label="Room">
              <option value="">All rooms</option>
              {rooms.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            <select value={filterAgent} onChange={(e) => setFilterAgent(e.target.value)} className={field} aria-label="Agent">
              <option value="">All agents</option>
              {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
            <select value={filterType} onChange={(e) => setFilterType(e.target.value)} className={field} aria-label="Type">
              <option value="">All types</option>
              <option value="text">Text</option>
              <option value="image">Images</option>
              <option value="other">Other</option>
            </select>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-6 space-y-6">
        {/* Upload: files plus the library fields they are stored with */}
        <section className="rounded-lg border border-slate-800/50 bg-slate-900/30 p-3 space-y-3">
          <div className="flex flex-wrap items-center gap-3 text-[10px]">
            <label className="flex items-center gap-1.5 text-slate-300 cursor-pointer">
              <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} className="accent-violet-500" />
              <span className="font-semibold tracking-wider">KEEP AS FIXTURE</span>
              <span className="text-slate-600">(never pruned)</span>
            </label>
            <input value={desk} onChange={(e) => setDesk(e.target.value)} placeholder="desk / PD number" className={`${field} w-32`} disabled={!keep} aria-label="Desk" />
            <select value={room} onChange={(e) => setRoom(e.target.value)} className={field} disabled={!keep} aria-label="Fixture room">
              <option value="">room…</option>
              {rooms.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            <input
              value={provenance}
              onChange={(e) => setProvenance(e.target.value)}
              placeholder="provenance: where from, how sanitized"
              className={`${field} flex-1 min-w-[16rem]`}
              disabled={!keep}
              aria-label="Provenance"
            />
          </div>
          <div
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            className={`rounded-lg border-2 border-dashed cursor-pointer transition-all duration-200 py-5 text-center ${
              dragOver ? 'border-emerald-500/50 bg-emerald-500/5' : 'border-slate-800/40 hover:border-slate-700/60 bg-slate-900/20'
            }`}
          >
            <input ref={fileInputRef} type="file" multiple onChange={handleFileSelect} className="hidden" />
            <div className="text-slate-600">
              {uploading ? (
                <span className="text-[11px] tracking-wider animate-pulse">UPLOADING...</span>
              ) : (
                <>
                  <span className="text-lg block mb-1">+</span>
                  <span className="text-[10px] tracking-wider">DROP FILES OR CLICK TO UPLOAD</span>
                  <span className="block text-[9px] text-slate-700 mt-1">sanitized copies only — customer originals stay in the Product Desk</span>
                </>
              )}
            </div>
          </div>
        </section>

        {/* Import from a peer's fixture library (production → development, sanitized files only) */}
        {peers.length > 0 && (
          <section className="rounded-lg border border-slate-800/50 bg-slate-900/30 p-3 space-y-2" data-testid="peer-import">
            <div className="flex flex-wrap items-center gap-2 text-[10px]">
              <span className="font-semibold tracking-wider text-slate-300">IMPORT FROM</span>
              <select value={importPeer} onChange={(e) => loadPeerFixtures(e.target.value)} className={field} aria-label="Peer">
                <option value="">peer…</option>
                {peers.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
              </select>
              <span className="text-slate-600">only files the peer marked as fixtures are offered; bytes are verified against the peer's sha256</span>
            </div>
            {peerError && <p className="text-[10px] text-red-400">{peerError}</p>}
            {peerFixtures && peerFixtures.length === 0 && !peerError && <p className="text-[10px] text-slate-600">No fixtures offered by {importPeer}.</p>}
            {peerFixtures && peerFixtures.length > 0 && (
              <ul className="divide-y divide-slate-800/40">
                {peerFixtures.map((f) => (
                  <li key={f.id} className="flex flex-wrap items-center gap-3 py-1.5 text-[10px]">
                    <span className="font-mono text-slate-200 truncate max-w-[18rem]" title={f.filename}>{f.filename}</span>
                    <span className="text-slate-600 font-mono">{formatBytes(f.size_bytes)}</span>
                    {f.desk && <span className="text-slate-400">desk #{f.desk}</span>}
                    {f.room && <span className="text-slate-500">{f.room}</span>}
                    {f.provenance && <span className="text-slate-600 truncate max-w-[20rem]" title={f.provenance}>{f.provenance}</span>}
                    <span className="ml-auto">
                      {importedIds.has(f.sha256) ? (
                        <span className="text-slate-600">in library</span>
                      ) : (
                        <button
                          onClick={() => importFixture(f)}
                          disabled={importing !== null}
                          className="px-2 py-0.5 rounded border border-violet-500/30 text-violet-300 font-semibold tracking-wider hover:bg-violet-500/10 disabled:opacity-40"
                        >
                          {importing === f.id ? '...' : 'IMPORT'}
                        </button>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {!loaded ? (
          <div className="flex items-center justify-center py-16">
            <div className="text-[10px] text-slate-600 tracking-[0.3em] uppercase animate-pulse">Loading…</div>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 gap-3">
            <span className="text-2xl text-slate-800">~</span>
            <p className="text-[11px] text-slate-600">
              {artifacts.length === 0
                ? view === 'fixtures' ? 'No fixtures yet — upload one, drop it into the fixture folder, or import from production' : 'No artifacts yet'
                : 'No matches for current filters'}
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
                rooms={rooms}
                index={i}
                onDelete={(id) => setArtifacts((prev) => prev.filter((a) => a.id !== id))}
                onUpdate={(updated) => setArtifacts((prev) => prev.map((a) => (a.id === updated.id ? updated : a)))}
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
