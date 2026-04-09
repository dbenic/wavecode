import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { apiGet } from '../hooks/useApi';
import { renderMarkdown } from '../utils/markdown';

interface DocEntry {
  slug: string;
  title: string;
  path: string;
  size: number;
  modified: string;
  agentId?: string;
  agentName?: string;
}

interface DocContent {
  title: string;
  content: string;
  path: string;
  agentId?: string;
  agentName?: string;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  return `${(bytes / 1024).toFixed(1)}KB`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function DocList({ docs, onSelect }: { docs: DocEntry[]; onSelect: (slug: string) => void }) {
  return (
    <div className="space-y-2">
      {docs.map((doc) => (
        <button
          key={doc.slug}
          onClick={() => onSelect(doc.slug)}
          className="w-full text-left px-4 py-3 rounded-lg bg-slate-900/60 border border-slate-800/40 hover:border-emerald-500/30 hover:bg-slate-900/80 transition-all group"
        >
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-medium text-slate-200 group-hover:text-emerald-400 transition-colors truncate">
                {doc.title}
              </div>
              <div className="flex items-center gap-2 mt-0.5">
                <span className="text-[10px] text-slate-600 font-mono">
                  {doc.path}
                </span>
                {doc.agentName && (
                  <span className="text-[8px] px-1.5 py-0.5 rounded bg-violet-950/60 border border-violet-500/30 text-violet-400 font-mono">
                    {doc.agentName}
                  </span>
                )}
              </div>
            </div>
            <div className="text-right shrink-0">
              <div className="text-[10px] text-slate-600">{formatSize(doc.size)}</div>
              <div className="text-[9px] text-slate-700">{formatDate(doc.modified)}</div>
            </div>
          </div>
        </button>
      ))}
    </div>
  );
}

function DocViewer({ slug, onBack }: { slug: string; onBack: () => void }) {
  const [doc, setDoc] = useState<DocContent | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    apiGet<DocContent>(`/docs/${slug}`)
      .then((data) => setDoc(data))
      .catch(() => setDoc(null))
      .finally(() => setLoading(false));
  }, [slug]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-[10px] text-slate-600 tracking-[0.3em] uppercase animate-pulse">Loading...</div>
      </div>
    );
  }

  if (!doc) {
    return (
      <div className="text-center py-20">
        <div className="text-slate-600 text-sm">Document not found</div>
        <button onClick={onBack} className="mt-4 text-emerald-400 text-xs hover:text-emerald-300">← Back</button>
      </div>
    );
  }

  return (
    <div>
      <button
        onClick={onBack}
        className="text-[10px] text-slate-600 hover:text-emerald-400 transition-colors mb-4 flex items-center gap-1"
      >
        ← Back to docs
      </button>
      <div className="flex items-baseline justify-between gap-3 mb-4">
        <h2 className="text-base font-bold text-slate-100">{doc.title}</h2>
        <div className="flex items-center gap-2 shrink-0">
          {doc.agentName && (
            <span className="text-[9px] px-1.5 py-0.5 rounded bg-violet-950/60 border border-violet-500/30 text-violet-400 font-mono">
              by {doc.agentName}
            </span>
          )}
          <span className="text-[9px] text-slate-700 font-mono">{doc.path}</span>
        </div>
      </div>
      <div
        className="prose-invert max-w-none"
        dangerouslySetInnerHTML={{ __html: renderMarkdown(doc.content) }}
      />
    </div>
  );
}

export default function Docs() {
  const navigate = useNavigate();
  const { slug } = useParams<{ slug?: string }>();
  const [docs, setDocs] = useState<DocEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiGet<DocEntry[]>('/docs')
      .then((data) => setDocs(data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="max-w-2xl mx-auto px-4 pt-6 pb-20">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-sm font-bold text-slate-300 tracking-[0.15em] uppercase">
          Docs
        </h1>
        <button
          onClick={() => navigate('/settings')}
          className="text-[10px] text-slate-600 hover:text-slate-400 transition-colors"
        >
          Settings ⚙
        </button>
      </div>

      {slug ? (
        <DocViewer slug={slug} onBack={() => navigate('/docs')} />
      ) : loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="text-[10px] text-slate-600 tracking-[0.3em] uppercase animate-pulse">Loading...</div>
        </div>
      ) : docs.length === 0 ? (
        <div className="text-center py-20">
          <div className="text-2xl mb-3">📄</div>
          <div className="text-slate-600 text-sm">No documents yet</div>
          <div className="text-[10px] text-slate-700 mt-2">Add .md files to the docs/ folder</div>
        </div>
      ) : (
        <DocList docs={docs} onSelect={(s) => navigate(`/docs/${s}`)} />
      )}
    </div>
  );
}
