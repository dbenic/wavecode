import { useState, useEffect, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { apiGet } from '../hooks/useApi';
import { renderMarkdown } from '../utils/markdown';

interface DocEntry {
  slug: string;
  title: string;
  path: string;
  size: number;
  modified: string;
  createdAt?: string;
  updatedAt?: string;
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

type SortKey = 'updated' | 'created';
const AGENT_FILTER_ALL = '__all__';
const AGENT_FILTER_NONE = '__none__';

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  return `${(bytes / 1024).toFixed(1)}KB`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function getSortDate(doc: DocEntry, sort: SortKey): string {
  if (sort === 'created') return doc.createdAt ?? doc.modified;
  return doc.updatedAt ?? doc.modified;
}

/** Trigger a browser download for the given markdown content. */
function downloadMarkdown(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  // Defer revoke so Safari/Firefox finish the download
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Pick a friendly download filename from a doc's path, always ending in .md. */
function downloadFilenameFor(docPath: string): string {
  const base = (docPath.split('/').pop() ?? docPath).trim() || 'document.md';
  return /\.md$/i.test(base) ? base : `${base}.md`;
}

function DocFilters({
  sort,
  onSortChange,
  agentFilter,
  onAgentFilterChange,
  agents,
  visibleCount,
  totalCount,
}: {
  sort: SortKey;
  onSortChange: (sort: SortKey) => void;
  agentFilter: string;
  onAgentFilterChange: (value: string) => void;
  agents: { id: string; name: string }[];
  visibleCount: number;
  totalCount: number;
}) {
  const selectClass = "bg-slate-900/80 border border-slate-800/60 hover:border-emerald-500/30 focus:border-emerald-500/50 focus:outline-none rounded-md px-2 py-1 text-[11px] text-slate-300 font-mono transition-colors";

  return (
    <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
      <div className="flex items-center gap-2">
        <label className="text-[9px] text-slate-600 tracking-[0.2em] uppercase">Sort</label>
        <select
          value={sort}
          onChange={(e) => onSortChange(e.target.value as SortKey)}
          className={selectClass}
          aria-label="Sort documents"
        >
          <option value="updated">Recently updated</option>
          <option value="created">Recently created</option>
        </select>

        <label className="text-[9px] text-slate-600 tracking-[0.2em] uppercase ml-2">Agent</label>
        <select
          value={agentFilter}
          onChange={(e) => onAgentFilterChange(e.target.value)}
          className={selectClass}
          aria-label="Filter by agent"
        >
          <option value={AGENT_FILTER_ALL}>All</option>
          <option value={AGENT_FILTER_NONE}>WaveCode (project)</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </select>
      </div>
      <span className="text-[9px] text-slate-700 font-mono">
        {visibleCount}/{totalCount}
      </span>
    </div>
  );
}

function DocList({ docs, onSelect }: { docs: DocEntry[]; onSelect: (slug: string) => void }) {
  if (docs.length === 0) {
    return (
      <div className="text-center py-10 rounded-lg bg-slate-900/40 border border-slate-800/40">
        <div className="text-slate-600 text-xs">No documents match these filters</div>
      </div>
    );
  }

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
      <div className="flex items-center justify-between gap-3 mb-4">
        <button
          onClick={onBack}
          className="text-[10px] text-slate-600 hover:text-emerald-400 transition-colors flex items-center gap-1"
        >
          ← Back to docs
        </button>
        <button
          onClick={() => downloadMarkdown(downloadFilenameFor(doc.path), doc.content)}
          className="text-[10px] tracking-[0.15em] uppercase px-3 py-1.5 rounded-md border border-emerald-500/30 bg-emerald-950/30 text-emerald-300 hover:bg-emerald-900/40 hover:border-emerald-400/50 transition-all flex items-center gap-1.5"
          title={`Download ${downloadFilenameFor(doc.path)}`}
          aria-label="Download markdown file"
        >
          <span aria-hidden="true">↓</span>
          Download .md
        </button>
      </div>
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
  const [sort, setSort] = useState<SortKey>('updated');
  const [agentFilter, setAgentFilter] = useState<string>(AGENT_FILTER_ALL);

  useEffect(() => {
    apiGet<DocEntry[]>('/docs')
      .then((data) => setDocs(data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  // Unique agents present in the doc set, sorted by name
  const agentOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const d of docs) {
      if (d.agentId && d.agentName && !seen.has(d.agentId)) {
        seen.set(d.agentId, d.agentName);
      }
    }
    return Array.from(seen, ([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [docs]);

  // Filtered + sorted view of the doc list
  const visibleDocs = useMemo(() => {
    const filtered = docs.filter((d) => {
      if (agentFilter === AGENT_FILTER_ALL) return true;
      if (agentFilter === AGENT_FILTER_NONE) return !d.agentId;
      return d.agentId === agentFilter;
    });

    return [...filtered].sort((a, b) => {
      const aDate = getSortDate(a, sort);
      const bDate = getSortDate(b, sort);
      // Newest first
      return bDate.localeCompare(aDate);
    });
  }, [docs, agentFilter, sort]);

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
        <>
          <DocFilters
            sort={sort}
            onSortChange={setSort}
            agentFilter={agentFilter}
            onAgentFilterChange={setAgentFilter}
            agents={agentOptions}
            visibleCount={visibleDocs.length}
            totalCount={docs.length}
          />
          <DocList docs={visibleDocs} onSelect={(s) => navigate(`/docs/${s}`)} />
        </>
      )}
    </div>
  );
}
