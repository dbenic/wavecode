import { useState } from 'react';
import { apiPost, apiDelete, apiPatch } from '../hooks/useApi';
import type { Artifact, Agent } from '../types';

const MIME_GLYPHS: Record<string, string> = {
  'text/typescript': 'TS',
  'text/x-python': 'PY',
  'application/javascript': 'JS',
  'application/json': '{}',
  'text/markdown': 'MD',
  'text/plain': 'TXT',
  'text/html': '<>',
  'text/css': 'CSS',
  'text/yaml': 'YML',
  'text/x-shellscript': 'SH',
  'text/x-sql': 'SQL',
  'text/x-diff': '+-',
  'text/xml': 'XML',
  'application/xml': 'XML',
  'text/csv': 'CSV',
  'application/pdf': 'PDF',
  'application/zip': 'ZIP',
};

const MIME_COLORS: Record<string, string> = {
  text: 'border-emerald-500/30 text-emerald-400',
  image: 'border-violet-500/30 text-violet-400',
  application: 'border-amber-500/30 text-amber-400',
};

function getGlyphColor(mime: string): string {
  const type = mime.split('/')[0];
  return MIME_COLORS[type] ?? 'border-slate-600/30 text-slate-400';
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

function isImage(mime: string): boolean {
  return mime.startsWith('image/') && mime !== 'image/svg+xml';
}

const field = 'px-1.5 py-1 rounded border border-slate-800/60 bg-slate-950/50 text-[10px] text-slate-300 font-mono focus:outline-none focus:border-violet-500/40';

export default function ArtifactThumbnail({
  artifact,
  agentName,
  agents,
  rooms = [],
  index,
  onDelete,
  onUpdate,
}: {
  artifact: Artifact;
  agentName?: string;
  agents: Agent[];
  rooms?: string[];
  index: number;
  onDelete?: (id: string) => void;
  onUpdate?: (artifact: Artifact) => void;
}) {
  const [showShare, setShowShare] = useState(false);
  const [shareAgent, setShareAgent] = useState('');
  const [sharing, setSharing] = useState(false);
  const [lightbox, setLightbox] = useState(false);
  const [imgError, setImgError] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [desk, setDesk] = useState(artifact.desk ?? '');
  const [room, setRoom] = useState(artifact.room ?? '');
  const [provenance, setProvenance] = useState(artifact.provenance ?? '');
  const [note, setNote] = useState(artifact.note ?? '');

  const isFixture = artifact.kind === 'fixture';
  const isDocument = artifact.kind === 'document';
  const isKept = isFixture || isDocument;

  const handleDelete = async () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setDeleting(true);
    try {
      await apiDelete(`/artifacts/${artifact.id}`);
      onDelete?.(artifact.id);
    } catch {
      // delete failed
    } finally {
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  const patch = async (body: Record<string, unknown>) => {
    setSaving(true);
    try {
      const updated = await apiPatch<Artifact>(`/artifacts/${artifact.id}`, body);
      onUpdate?.(updated);
      return true;
    } catch {
      return false;
    } finally {
      setSaving(false);
    }
  };

  const keep = () => patch({ kind: 'fixture' });

  const saveMeta = async () => {
    const ok = await patch({
      kind: artifact.kind === 'transient' ? 'fixture' : artifact.kind,
      desk: desk.trim() || null,
      room: room || null,
      provenance: provenance.trim() || null,
      note: note.trim() || null,
    });
    if (ok) setEditing(false);
  };

  const glyph = MIME_GLYPHS[artifact.mime_type] ?? '???';
  const glyphColor = getGlyphColor(artifact.mime_type);
  const shortHash = artifact.sha256.substring(0, 8);
  const imageUrl = `/api/artifacts/${artifact.id}/download`;
  const showImage = isImage(artifact.mime_type) && !imgError;
  const rooms_ = artifact.room && !rooms.includes(artifact.room) ? [artifact.room, ...rooms] : rooms;

  const handleShare = async () => {
    if (!shareAgent) return;
    setSharing(true);
    try {
      await apiPost(`/artifacts/${artifact.id}/share`, { targetAgentId: shareAgent });
      setShowShare(false);
      setShareAgent('');
    } catch {
      // share failed
    } finally {
      setSharing(false);
    }
  };

  return (
    <>
      <div
        className={`rounded-lg border bg-gradient-to-br from-slate-900/80 to-slate-950/90 overflow-hidden transition-all duration-200 ${
          isFixture ? 'border-violet-500/25 hover:border-violet-500/40' : isDocument ? 'border-sky-500/20 hover:border-sky-500/40' : 'border-slate-800/50 hover:border-slate-700/50'
        }`}
        style={{ animationDelay: `${index * 50}ms`, animation: 'artifactIn 0.35s ease-out both' }}
        data-testid="artifact-card"
      >
        {showImage && (
          <button onClick={() => setLightbox(true)} className="w-full aspect-video bg-black/40 overflow-hidden cursor-zoom-in group">
            <img
              src={imageUrl}
              alt={artifact.filename}
              onError={() => setImgError(true)}
              className="w-full h-full object-cover transition-transform duration-200 group-hover:scale-105"
              loading="lazy"
            />
          </button>
        )}

        <div className="p-3 space-y-2.5">
          <div className="flex items-start gap-2.5">
            {!showImage && (
              <div className={`flex-shrink-0 flex items-center justify-center w-10 h-10 rounded border font-mono text-xs font-bold ${glyphColor} bg-black/30`}>
                {glyph}
              </div>
            )}
            <div className="min-w-0 flex-1">
              <p className="text-[11px] text-slate-200 font-mono truncate" title={artifact.filename}>{artifact.filename}</p>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-0.5">
                {isFixture && (
                  <span className="text-[8px] font-bold tracking-wider rounded px-1 py-px border border-violet-500/40 text-violet-300 bg-violet-950/40">FIXTURE</span>
                )}
                {isDocument && (
                  <span className="text-[8px] font-bold tracking-wider rounded px-1 py-px border border-sky-500/40 text-sky-300 bg-sky-950/40">DOCUMENT</span>
                )}
                {artifact.desk && <span className="text-[9px] text-slate-300">desk #{artifact.desk}</span>}
                {artifact.room && <span className="text-[9px] text-slate-500">{artifact.room}</span>}
                <span className="text-[9px] text-slate-600 font-mono">{formatBytes(artifact.size_bytes)}</span>
                <span className="text-[9px] text-slate-700 font-mono">{shortHash}</span>
                {showImage && (
                  <button onClick={() => setLightbox(true)} className="text-[9px] text-violet-400 hover:text-violet-300 font-semibold tracking-wider transition-colors">VIEW</button>
                )}
              </div>
              {artifact.provenance && (
                <p className="text-[9px] text-slate-500 mt-1 line-clamp-2" title={artifact.provenance}>{artifact.provenance}</p>
              )}
              {artifact.note && !artifact.provenance && (
                <p className="text-[9px] text-slate-500 mt-1 line-clamp-2" title={artifact.note}>{artifact.note}</p>
              )}
            </div>
          </div>

          <div className="flex items-center justify-between">
            <span className="text-[9px] text-slate-600 truncate">
              {agentName ? <span className="text-slate-500">{agentName}</span> : <span className="italic">uploaded</span>}
              <span className="text-slate-700"> · {artifact.created_at.slice(0, 10)}</span>
            </span>
            <div className="flex items-center gap-2">
              <a href={imageUrl} download={artifact.filename} className="text-[9px] font-semibold tracking-wider text-slate-500 hover:text-slate-300 transition-colors">DL</a>
              <button onClick={() => setShowShare(!showShare)} className="text-[9px] font-semibold tracking-wider text-cyan-500 hover:text-cyan-400 transition-colors">SHARE</button>
              {isKept ? (
                <button onClick={() => setEditing(!editing)} className="text-[9px] font-semibold tracking-wider text-violet-400 hover:text-violet-300 transition-colors">EDIT</button>
              ) : (
                <button onClick={keep} disabled={saving} title="Keep in the library: never pruned" className="text-[9px] font-semibold tracking-wider text-violet-400 hover:text-violet-300 transition-colors disabled:opacity-40">
                  {saving ? '...' : 'KEEP'}
                </button>
              )}
              <button
                onClick={handleDelete}
                onBlur={() => setConfirmDelete(false)}
                disabled={deleting}
                className={`text-[9px] font-semibold tracking-wider transition-colors ${confirmDelete ? 'text-red-400 hover:text-red-300' : 'text-slate-600 hover:text-red-400'} disabled:opacity-40`}
              >
                {deleting ? '...' : confirmDelete ? 'CONFIRM?' : 'DEL'}
              </button>
            </div>
          </div>

          {showShare && (
            <div className="flex items-center gap-1.5 pt-1 border-t border-slate-800/30">
              <select value={shareAgent} onChange={(e) => setShareAgent(e.target.value)} className={`flex-1 ${field}`} aria-label="Share with agent">
                <option value="">Agent...</option>
                {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
              <button onClick={handleShare} disabled={!shareAgent || sharing} className="px-2 py-1 rounded border border-cyan-500/30 text-[9px] font-semibold text-cyan-400 hover:bg-cyan-500/10 transition-all disabled:opacity-40">
                {sharing ? '...' : 'GO'}
              </button>
            </div>
          )}

          {editing && (
            <div className="space-y-1.5 pt-1 border-t border-slate-800/30" data-testid="artifact-edit">
              <div className="flex items-center gap-1.5">
                <input value={desk} onChange={(e) => setDesk(e.target.value)} placeholder="desk / PD number" className={`w-28 ${field}`} aria-label="Desk" />
                <select value={room} onChange={(e) => setRoom(e.target.value)} className={`flex-1 ${field}`} aria-label="Room">
                  <option value="">room…</option>
                  {rooms_.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              </div>
              <input value={provenance} onChange={(e) => setProvenance(e.target.value)} placeholder="provenance: where from, how sanitized" className={`w-full ${field}`} aria-label="Provenance" />
              <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="note" className={`w-full ${field}`} aria-label="Note" />
              <div className="flex items-center justify-end gap-2">
                <button onClick={() => setEditing(false)} className="text-[9px] text-slate-500 hover:text-slate-300 tracking-wider">CANCEL</button>
                <button onClick={saveMeta} disabled={saving} className="px-2 py-1 rounded border border-violet-500/30 text-[9px] font-semibold text-violet-300 hover:bg-violet-500/10 disabled:opacity-40">
                  {saving ? '...' : 'SAVE'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {lightbox && (
        <div className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-4 sm:p-8" onClick={() => setLightbox(false)}>
          <button
            onClick={() => setLightbox(false)}
            className="absolute top-4 right-4 w-10 h-10 rounded-full bg-slate-800/80 border border-slate-600/50 text-slate-300 hover:text-white hover:bg-slate-700 transition-all flex items-center justify-center text-lg z-10"
          >
            &times;
          </button>
          <div className="absolute top-4 left-4 px-3 py-1.5 rounded-lg bg-slate-900/90 border border-slate-700/50">
            <p className="text-[11px] text-slate-300 font-mono">{artifact.filename}</p>
            <p className="text-[9px] text-slate-500">{formatBytes(artifact.size_bytes)}</p>
          </div>
          <img src={imageUrl} alt={artifact.filename} onClick={(e) => e.stopPropagation()} className="max-w-full max-h-full object-contain rounded-lg shadow-2xl" />
          <a
            href={imageUrl}
            download={artifact.filename}
            onClick={(e) => e.stopPropagation()}
            className="absolute bottom-4 right-4 px-4 py-2 rounded-lg bg-slate-800/80 border border-slate-600/50 text-[11px] font-bold tracking-wider text-slate-300 hover:text-white hover:bg-slate-700 transition-all"
          >
            DOWNLOAD
          </a>
        </div>
      )}
    </>
  );
}
