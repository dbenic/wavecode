import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { apiGet } from '../hooks/useApi';
import { renderMarkdown } from '../utils/markdown';
import { internalLinkClickHandler } from '../utils/paths';

interface ViewableFile {
  path: string;
  name: string;
  size: number;
  modified_at: string;
  kind: 'markdown' | 'text';
  content: string;
}

/**
 * Read-only viewer for a path an agent mentioned (`/file?path=…`). The server
 * serves only files under its browsable roots (rooms, worktrees, projects,
 * transcripts, artifacts, configured extras), so this never shows credentials.
 */
export default function FileView() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const filePath = params.get('path') ?? '';
  const [file, setFile] = useState<ViewableFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setFile(null);
    setError(null);
    if (!filePath) {
      setError('No path given');
      return;
    }
    apiGet<ViewableFile>(`/files/view?path=${encodeURIComponent(filePath)}`)
      .then(setFile)
      .catch((e: Error) => setError(e.message || 'Could not open file'));
  }, [filePath]);

  const copyPath = () => {
    void navigator.clipboard?.writeText(filePath).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="max-w-3xl lg:max-w-5xl mx-auto px-4 py-3">
      <header className="flex items-start justify-between gap-3 mb-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <button onClick={() => navigate(-1)} className="text-slate-500 hover:text-slate-300 text-sm" aria-label="Back">&larr;</button>
            <h1 className="text-sm font-bold text-slate-100 truncate">{file?.name ?? filePath.split('/').pop() ?? 'File'}</h1>
            {file && (
              <span className="text-[10px] text-slate-500 tabular-nums">
                {formatSize(file.size)} · {new Date(file.modified_at).toLocaleString()}
              </span>
            )}
          </div>
          <p className="text-[10px] text-slate-600 font-mono break-all">{filePath}</p>
        </div>
        <button
          onClick={copyPath}
          className="flex-shrink-0 px-2 py-1 rounded border border-slate-700 bg-slate-900 text-[10px] font-semibold uppercase tracking-wider text-slate-300 hover:bg-slate-800"
        >
          {copied ? 'Copied' : 'Copy path'}
        </button>
      </header>

      {error && (
        <div role="alert" className="rounded-lg border border-red-500/30 bg-red-950/30 px-3 py-2 text-xs text-red-200">
          {error}
        </div>
      )}
      {!error && !file && <div className="text-xs text-slate-500 animate-pulse">Loading…</div>}
      {file && file.kind === 'markdown' && (
        <article
          data-testid="file-markdown"
          className="rounded-lg border border-slate-800/60 bg-slate-900/40 px-4 py-3 break-words [&_table]:block [&_table]:overflow-x-auto"
          onClick={internalLinkClickHandler((to) => navigate(to))}
          dangerouslySetInnerHTML={{ __html: renderMarkdown(file.content) }}
        />
      )}
      {file && file.kind === 'text' && (
        <pre data-testid="file-text" className="rounded-lg border border-slate-800/60 bg-slate-900/40 px-4 py-3 text-[11px] leading-relaxed text-slate-300 font-mono whitespace-pre-wrap break-words overflow-x-auto">
          {file.content}
        </pre>
      )}
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
