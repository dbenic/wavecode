import { useState, useEffect, useRef, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiGet, apiPost, apiDelete } from '../hooks/useApi';
import type { ChatMessage, Agent } from '../types';
import MdFileActions, { extractMdPaths } from '../components/MdFileActions';

/** Replace .md file paths in text with actionable chips */
function renderWithMdActions(text: string, agents: Agent[]): ReactNode {
  const mdPaths = extractMdPaths(text);
  if (mdPaths.length === 0) return text;

  // Build a regex that matches any of the detected paths
  const escaped = mdPaths.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const regex = new RegExp(`(${escaped.join('|')})`, 'g');
  const parts = text.split(regex);

  return parts.map((part, i) => {
    if (mdPaths.includes(part)) {
      return <MdFileActions key={i} filePath={part} agents={agents} />;
    }
    return part;
  });
}

export default function CommandChat() {
  const navigate = useNavigate();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [showMentions, setShowMentions] = useState(false);
  const [mentionFilter, setMentionFilter] = useState('');
  const [loaded, setLoaded] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    apiGet<ChatMessage[]>('/chat/history')
      .then((data) => { setMessages(data); setLoaded(true); })
      .catch(() => setLoaded(true));
    apiGet<Agent[]>('/agents').then(setAgents).catch(() => {});
  }, []);

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, sending]);

  const handleSend = async () => {
    if (!input.trim() || sending) return;
    const userMsg = input.trim();
    setInput('');
    setSending(true);

    // Optimistic: add user message immediately
    const tempUserMsg: ChatMessage = {
      id: `temp-${Date.now()}`,
      role: 'user',
      content: userMsg,
      tool_calls: null,
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, tempUserMsg]);

    try {
      const result = await apiPost<{ reply: string; toolCalls: string[] }>('/chat/send', { message: userMsg });

      // Add assistant response
      const assistantMsg: ChatMessage = {
        id: `temp-${Date.now()}-reply`,
        role: 'assistant',
        content: result.reply,
        tool_calls: result.toolCalls.length > 0 ? JSON.stringify(result.toolCalls) : null,
        created_at: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, assistantMsg]);
    } catch (e) {
      const errorMsg: ChatMessage = {
        id: `temp-${Date.now()}-err`,
        role: 'assistant',
        content: `Error: ${(e as Error).message}`,
        tool_calls: null,
        created_at: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, errorMsg]);
    } finally {
      setSending(false);
      textareaRef.current?.focus();
    }
  };

  const handleClear = async () => {
    await apiDelete('/chat/history');
    setMessages([]);
  };

  return (
    <div className="h-screen bg-slate-950 flex flex-col">
      {/* Header with agent status */}
      <header className="flex-shrink-0 border-b-2 border-slate-700/80 bg-slate-900">
        <div className="max-w-3xl mx-auto px-4 py-2 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img src="/favicon.svg" alt="WaveCode" className="w-7 h-7" />
            <div>
              <h1 className="text-sm font-bold tracking-[0.15em] text-slate-100 uppercase">Command Center</h1>
              <p className="text-[9px] text-slate-500 tracking-[0.3em] uppercase">AI Mission Control</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => navigate('/dashboard')}
              className="hidden sm:inline-flex px-2 py-1 rounded bg-slate-800 border border-slate-600/50 text-[9px] font-bold tracking-wider text-slate-400 hover:text-slate-200 hover:border-slate-500 transition-all"
            >
              AGENTS
            </button>
            {messages.length > 0 && (
              <button
                onClick={handleClear}
                className="px-2 py-1 rounded bg-slate-800 border border-slate-600/50 text-[9px] font-bold tracking-wider text-slate-400 hover:text-slate-200 hover:border-slate-500 transition-all"
              >
                CLEAR
              </button>
            )}
          </div>
        </div>
        {/* Compact agent status strip */}
        <div className="max-w-3xl mx-auto px-4 pb-1.5 flex items-center gap-1.5 overflow-x-auto">
          {agents.map((a) => (
            <button
              key={a.id}
              onClick={() => navigate(`/agent/${a.id}`)}
              title={`${a.name} (${a.runtime}) — ${a.status}`}
              className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[8px] font-mono transition-all hover:bg-slate-800 ${
                a.status === 'working' ? 'text-emerald-400' : 'text-slate-600'
              }`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${
                a.status === 'working' ? 'bg-emerald-400 animate-pulse' :
                a.status === 'error' ? 'bg-red-500' : 'bg-slate-700'
              }`} />
              {a.name}
            </button>
          ))}
        </div>
      </header>

      {/* Messages area */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-4 py-4">
          {!loaded ? (
            <div className="flex items-center justify-center h-full py-20">
              <span className="text-[10px] text-slate-600 tracking-[0.3em] uppercase animate-pulse">Loading...</span>
            </div>
          ) : messages.length === 0 ? (
            /* Empty state — mission briefing prompt */
            <div className="flex flex-col items-center justify-center py-32 gap-6">
              <div className="text-center space-y-3">
                <div className="text-[10px] text-slate-600 tracking-[0.4em] uppercase">WaveCode Command Center</div>
                <h2 className="text-2xl sm:text-3xl font-bold text-slate-300 tracking-tight">
                  What do you want to code today?
                </h2>
                <div className="flex items-center justify-center gap-1 mt-4">
                  <span className="text-emerald-500 font-mono text-lg">&#9656;</span>
                  <span className="w-2.5 h-5 bg-emerald-400/70 animate-pulse" />
                </div>
                <p className="text-[11px] text-slate-600 max-w-sm mx-auto mt-4 leading-relaxed">
                  Describe what you need and I'll spin up the right agents.
                  I can spawn Claude Code, Codex, or Aider sessions, group them into teams, hand off specs, and build dependent task graphs.
                </p>
              </div>
              {/* Quick suggestions */}
              <div className="flex flex-wrap gap-2 justify-center max-w-2xl">
                {[
                  'Start a new agent using codex named productmanager in repo "/path/to/app"',
                  'Create a team named project-x with productmanager as lead, projectx-frontend as frontend, projectx-backend as backend',
                  'Handoff spec from productmanager to projectx-frontend',
                  'Create dependent task graph:\n- productmanager: write docs/spec.md\n- projectx-frontend: build the UI\n- projectx-backend: build the API\n- projectx-deploy: deploy the app',
                ].map((suggestion) => (
                  <button
                    key={suggestion}
                    onClick={() => { setInput(suggestion); textareaRef.current?.focus(); }}
                    className="px-3 py-1.5 rounded-lg bg-slate-800/60 border border-slate-700/50 text-[10px] text-slate-400 hover:text-slate-200 hover:border-slate-600 transition-all"
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            /* Message list */
            <div className="space-y-3">
              {messages.map((msg) => (
                <div
                  key={msg.id}
                  className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                >
                  <div className={`max-w-[85%] space-y-1.5 ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
                    {/* Message bubble */}
                    <div
                      className={`rounded-lg px-3.5 py-2.5 ${
                        msg.role === 'user'
                          ? 'bg-slate-800 border border-slate-700/50 text-slate-100'
                          : 'bg-slate-900/80 border border-slate-800/50 text-slate-200'
                      }`}
                    >
                      <p className={`text-[13px] leading-relaxed whitespace-pre-wrap ${
                        msg.role === 'assistant' ? 'font-mono' : ''
                      }`}>
                        {msg.role === 'assistant' ? renderWithMdActions(msg.content, agents) : msg.content}
                      </p>
                    </div>

                    {/* Tool calls */}
                    {msg.tool_calls && (
                      <div className="flex flex-wrap gap-1 px-1">
                        {((() => { try { return JSON.parse(msg.tool_calls!) as string[]; } catch { return []; } })()).map((tc, i) => (
                          <span
                            key={i}
                            className="inline-block px-2 py-0.5 rounded bg-emerald-950/80 border border-emerald-500/30 text-[9px] text-emerald-300 font-mono"
                          >
                            {tc}
                          </span>
                        ))}
                      </div>
                    )}

                    {/* Timestamp */}
                    <div className={`text-[9px] text-slate-700 px-1 ${msg.role === 'user' ? 'text-right' : ''}`}>
                      {new Date(msg.created_at).toLocaleTimeString()}
                    </div>
                  </div>
                </div>
              ))}

              {/* Sending indicator */}
              {sending && (
                <div className="flex justify-start">
                  <div className="bg-slate-900/80 border border-slate-800/50 rounded-lg px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className="flex gap-1">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-bounce" style={{ animationDelay: '0ms' }} />
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-bounce" style={{ animationDelay: '150ms' }} />
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-bounce" style={{ animationDelay: '300ms' }} />
                      </span>
                      <span className="text-[10px] text-slate-500 tracking-wider font-mono">PROCESSING</span>
                    </div>
                  </div>
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>
          )}
        </div>
      </div>

      {/* Input — backlit console style */}
      <div className="flex-shrink-0 border-t-2 border-slate-700/80 bg-slate-900">
        <div className="max-w-3xl mx-auto px-4 py-2.5 space-y-1.5">
          {/* @mention autocomplete */}
          {showMentions && (
            <div className="flex items-center gap-1 flex-wrap">
              <span className="text-[9px] text-slate-500 font-bold tracking-wider">@</span>
              {agents
                .filter((a) => !mentionFilter || a.name.includes(mentionFilter))
                .map((a) => (
                  <button
                    key={a.id}
                    onClick={() => {
                      // Replace the @partial with @full-name
                      const before = input.substring(0, input.lastIndexOf('@'));
                      setInput(before + '@' + a.name + ' ');
                      setShowMentions(false);
                      textareaRef.current?.focus();
                    }}
                    className={`px-2 py-0.5 rounded text-[10px] font-mono transition-all active:scale-95 ${
                      a.status === 'idle'
                        ? 'bg-emerald-950 border border-emerald-500/40 text-emerald-300 hover:bg-emerald-900'
                        : 'bg-slate-800 border border-slate-600/50 text-slate-300 hover:bg-slate-700'
                    }`}
                  >
                    @{a.name}
                    <span className="text-[8px] text-slate-500 ml-1">{a.runtime}</span>
                  </button>
                ))}
            </div>
          )}

          <div className="flex gap-1.5 items-end">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => {
                const val = e.target.value;
                setInput(val);
                // Detect @ typing for autocomplete
                const lastAt = val.lastIndexOf('@');
                if (lastAt >= 0 && lastAt === val.length - 1) {
                  setShowMentions(true);
                  setMentionFilter('');
                } else if (lastAt >= 0 && !val.substring(lastAt).includes(' ')) {
                  setShowMentions(true);
                  setMentionFilter(val.substring(lastAt + 1));
                } else {
                  setShowMentions(false);
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
                if (e.key === 'Escape') setShowMentions(false);
              }}
              rows={input.includes('\n') ? 3 : 1}
              placeholder="Spawn agents, create teams, hand off specs, or build task graphs... use @agent to tag agents"
              disabled={sending}
              className="flex-1 px-3 py-1.5 rounded-lg border-2 border-slate-600/60 bg-slate-800/80 text-sm text-slate-100 font-mono placeholder:text-slate-500 resize-none focus:outline-none focus:border-emerald-400/60 focus:ring-2 focus:ring-emerald-400/15 transition-all disabled:opacity-50"
            />
            <button
              onClick={handleSend}
              disabled={sending || !input.trim()}
              className={`px-3 py-1.5 rounded-lg border text-[11px] font-bold tracking-wider transition-all
                ${sending || !input.trim()
                  ? 'bg-slate-900 border-slate-800 text-slate-600 cursor-not-allowed'
                  : 'bg-emerald-950 border-emerald-500/50 text-emerald-300 hover:bg-emerald-900 hover:text-emerald-200 active:scale-95 shadow-[0_0_10px_rgba(16,185,129,0.2)]'}`}
            >
              {sending ? '..' : 'SEND'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
