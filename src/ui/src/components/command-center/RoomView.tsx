/**
 * The Room tab (spec §5e): the project's shared folder — SPEC.md, ROOM.md,
 * LEDGER.md, DECISIONS.md, REPORTS/, TEMPLATES/. File list, inline markdown
 * view, edit for the files you may write, and "send to @agent" on any file.
 * Write access is decided by the server (`writable`), never here.
 */

import { useCallback, useEffect, useState } from 'react';
import { apiGet, apiPost, apiPut } from '../../hooks/useApi';
import type { SSEEvent } from '../../hooks/useSSE';
import type { Agent } from '../../types';
import { renderMarkdown } from '../../utils/markdown';
import { handleOf } from '../../utils/composer-grammar';

export interface RoomSummary {
  project: string;
  root: string;
  owner: string | null;
  can_write_spec: boolean;
  is_default?: boolean;
}

interface DocEntry {
  path: string;
  size: number;
  modified_at: string;
  writable: boolean;
}

interface RoomViewProps {
  agents: Agent[];
  /** Latest SSE event, so the view refreshes when files change. */
  lastEvent?: SSEEvent | null;
}

export function sendFilePrompt(room: Pick<RoomSummary, 'project' | 'root'>, path: string): string {
  return `Please read the project room file ${room.root}/${path} (room ${room.project}; also at .wavecode/room/${path} in your workspace) and act on it.`;
}

export default function RoomView({ agents, lastEvent }: RoomViewProps) {
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [project, setProject] = useState<string | null>(null);
  const [docs, setDocs] = useState<DocEntry[]>([]);
  const [path, setPath] = useState<string | null>(null);
  const [content, setContent] = useState<string>('');
  const [writable, setWritable] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [sendTo, setSendTo] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const room = rooms.find((r) => r.project === project) ?? null;

  useEffect(() => {
    apiGet<RoomSummary[]>('/rooms')
      .then((list) => {
        setRooms(list);
        setProject((current) => current ?? list.find((r) => r.is_default)?.project ?? list[0]?.project ?? null);
      })
      .catch(() => {});
  }, []);

  const loadDocs = useCallback(async (p: string) => {
    try {
      const res = await apiGet<{ docs: DocEntry[] }>(`/rooms/${encodeURIComponent(p)}/docs`);
      setDocs(res.docs);
    } catch {
      setDocs([]);
    }
  }, []);

  const openDoc = useCallback(async (p: string, docPath: string) => {
    setError(null);
    setNotice(null);
    try {
      const res = await apiGet<{ content: string; writable: boolean }>(
        `/rooms/${encodeURIComponent(p)}/docs/${docPath.split('/').map(encodeURIComponent).join('/')}`,
      );
      setPath(docPath);
      setContent(res.content);
      setWritable(res.writable);
      setDraft(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    if (!project) return;
    setPath(null);
    setDraft(null);
    void loadDocs(project).then(() => openDoc(project, 'SPEC.md'));
  }, [project, loadDocs, openDoc]);

  // Live: another seat wrote a file or WaveCode added a report
  useEffect(() => {
    if (!project || !lastEvent || !lastEvent.type.startsWith('room.')) return;
    if (lastEvent.payload?.project !== project) return;
    void loadDocs(project);
    if (lastEvent.payload?.path === path && draft === null && path) void openDoc(project, path);
  }, [lastEvent, project, path, draft, loadDocs, openDoc]);

  async function save() {
    if (!project || !path || draft === null) return;
    setError(null);
    try {
      await apiPut(`/rooms/${encodeURIComponent(project)}/docs/${path.split('/').map(encodeURIComponent).join('/')}`, { content: draft });
      setContent(draft);
      setDraft(null);
      setNotice(`Saved ${path}`);
      void loadDocs(project);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function send() {
    if (!room || !path || !sendTo) return;
    setError(null);
    try {
      await apiPost(`/agents/${sendTo}/send`, { text: sendFilePrompt(room, path) });
      const target = agents.find((a) => a.id === sendTo);
      setNotice(`Sent ${path} to @${target ? handleOf(target) : sendTo}`);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (rooms.length === 0) {
    return <p className="p-4 text-xs text-slate-600">No project rooms yet — configure projects, or create one with POST /api/rooms.</p>;
  }

  return (
    <section aria-label="Room" className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-800/60 px-3 py-2">
        <label htmlFor="room-picker" className="text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-500">Room</label>
        <select
          id="room-picker"
          value={project ?? ''}
          onChange={(e) => setProject(e.target.value)}
          className="rounded border border-slate-700 bg-slate-900 px-1.5 py-0.5 text-xs text-slate-200"
        >
          {rooms.map((r) => <option key={r.project} value={r.project}>{r.project}</option>)}
        </select>
        {room?.owner && <span className="text-[11px] text-slate-500">owner {room.owner}</span>}
      </div>
      <div className="flex min-h-0 flex-1">
        <ul aria-label="Room files" className="w-48 shrink-0 overflow-y-auto border-r border-slate-800/60 py-1">
          {docs.map((d) => (
            <li key={d.path}>
              <button
                type="button"
                onClick={() => project && void openDoc(project, d.path)}
                aria-current={d.path === path ? 'true' : undefined}
                className={`block w-full truncate px-3 py-1 text-left text-xs ${d.path === path ? 'bg-slate-800 text-white' : 'text-slate-400 hover:text-slate-200'}`}
                title={d.writable ? 'You may edit this file' : 'Read-only for you'}
              >
                {d.path}{d.writable ? '' : ' 🔒'}
              </button>
            </li>
          ))}
        </ul>
        <div className="flex min-w-0 flex-1 flex-col">
          {path && (
            <div className="flex flex-wrap items-center gap-2 border-b border-slate-800/60 px-3 py-1.5 text-xs">
              <span className="font-medium text-slate-300">{path}</span>
              {writable && draft === null && (
                <button type="button" onClick={() => setDraft(content)} className="rounded border border-slate-600 px-2 py-0.5 text-slate-200">Edit</button>
              )}
              {draft !== null && (
                <>
                  <button type="button" onClick={() => void save()} className="rounded bg-emerald-600 px-2 py-0.5 font-semibold text-white">Save</button>
                  <button type="button" onClick={() => setDraft(null)} className="rounded border border-slate-600 px-2 py-0.5 text-slate-300">Cancel</button>
                </>
              )}
              <span className="ml-auto flex items-center gap-1">
                <label htmlFor="room-send-to" className="sr-only">Send to</label>
                <select id="room-send-to" value={sendTo} onChange={(e) => setSendTo(e.target.value)} className="rounded border border-slate-700 bg-slate-900 px-1 py-0.5 text-slate-200">
                  <option value="">send to @…</option>
                  {agents.filter((a) => a.can_act !== false).map((a) => <option key={a.id} value={a.id}>@{handleOf(a)}</option>)}
                </select>
                <button type="button" disabled={!sendTo} onClick={() => void send()} className="rounded border border-sky-600 px-2 py-0.5 text-sky-300 disabled:opacity-40">Send</button>
              </span>
            </div>
          )}
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            {draft !== null ? (
              <textarea
                aria-label={`Edit ${path}`}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                className="h-full min-h-[20rem] w-full rounded border border-slate-700 bg-slate-900 p-2 font-mono text-xs text-slate-100"
              />
            ) : path ? (
              <article
                data-testid="room-doc"
                className="prose-invert text-sm text-slate-300"
                // renderMarkdown escapes HTML first and sanitizes the result (DOMPurify)
                dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }}
              />
            ) : null}
          </div>
          {notice && <p role="status" className="px-3 py-1 text-xs text-emerald-400">{notice}</p>}
          {error && <p role="alert" className="px-3 py-1 text-xs text-red-400">{error}</p>}
        </div>
      </div>
    </section>
  );
}
