import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { apiGet, apiPost, apiUpload, apiDelete } from '../hooks/useApi';
import { useSSE, type SSEEvent } from '../hooks/useSSE';
import type { Agent, Run } from '../types';
import { shouldRefreshAgentOutput } from '../sse-events';
import { sanitizeHtml } from '../utils/sanitize';
import { createAgentDocSlug } from '../utils/docs';
import StatusBadge from '../components/StatusBadge';
import { extractMdPaths } from '../components/MdFileActions';
import AgentGuidesBar from '../components/AgentGuidesBar';
import DecisionsBar from '../components/DecisionsBar';

export default function AgentView() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [agent, setAgent] = useState<Agent | null>(null);
  const [allAgents, setAllAgents] = useState<Agent[]>([]);
  const [output, setOutput] = useState('');
  const [outputHtml, setOutputHtml] = useState('');
  const [prompt, setPrompt] = useState('');
  const [sending, setSending] = useState(false);
  const [enhancing, setEnhancing] = useState(false);
  const [enhancerAvailable, setEnhancerAvailable] = useState(false);
  const [promptExpanded, setPromptExpanded] = useState(false);
  const [promptMode, setPromptMode] = useState<'direct' | 'ai'>('direct');
  const [aiResponse, setAiResponse] = useState('');
  const [attachedFiles, setAttachedFiles] = useState<{ name: string; path: string }[]>([]);
  const [uploading, setUploading] = useState(false);
  const [agentArtifacts, setAgentArtifacts] = useState<{ id: string; filename: string; mime_type: string; size_bytes: number; created_at: string; note?: string }[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [currentRun, setCurrentRun] = useState<Run | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [olderHtml, setOlderHtml] = useState('');
  const [scrollbackLoaded, setScrollbackLoaded] = useState(100); // lines loaded so far
  const [hasMoreScrollback, setHasMoreScrollback] = useState(true);
  const touchStartX = useRef(0);
  const touchEndX = useRef(0);
  const outputRef = useRef<HTMLDivElement>(null);
  const outputRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const outputRequestInFlightRef = useRef(false);
  const queuedOutputRefreshRef = useRef(false);
  const outputVersionRef = useRef(0);
  const pendingOutputVersionRef = useRef(0);

  const fetchOutput = useCallback(async () => {
    if (!id) return;
    if (outputRequestInFlightRef.current) {
      queuedOutputRefreshRef.current = true;
      return;
    }

    outputRequestInFlightRef.current = true;

    try {
      const data = await apiGet<{ output: string; html?: string }>(`/agents/${id}/output?lines=100&ansi=true`);
      setOutput(data.output);
      setOutputHtml(data.html ?? '');
      outputVersionRef.current = Math.max(outputVersionRef.current, pendingOutputVersionRef.current);
    } catch {
      // output refresh failed
      if (pendingOutputVersionRef.current > outputVersionRef.current) {
        if (outputRefreshTimerRef.current) {
          clearTimeout(outputRefreshTimerRef.current);
        }
        outputRefreshTimerRef.current = setTimeout(() => {
          outputRefreshTimerRef.current = null;
          void fetchOutput();
        }, 1000);
      }
    } finally {
      outputRequestInFlightRef.current = false;
      if (queuedOutputRefreshRef.current) {
        queuedOutputRefreshRef.current = false;
        void fetchOutput();
      }
    }
  }, [id]);

  const scheduleOutputRefresh = useCallback((delayMs: number = 0) => {
    if (outputRefreshTimerRef.current) {
      clearTimeout(outputRefreshTimerRef.current);
    }

    outputRefreshTimerRef.current = setTimeout(() => {
      outputRefreshTimerRef.current = null;
      void fetchOutput();
    }, delayMs);
  }, [fetchOutput]);

  // Fetch agent + output + runs
  useEffect(() => {
    if (!id) return;

    apiGet<Agent>(`/agents/${id}`)
      .then((data) => {
        setAgent(data);
        outputVersionRef.current = data.outputVersion ?? 0;
        pendingOutputVersionRef.current = data.outputVersion ?? 0;
      })
      .catch(() => navigate('/'));
    scheduleOutputRefresh();

    // Check if prompt enhancer is available
    apiGet<{ available: boolean }>('/enhance/status')
      .then((data) => setEnhancerAvailable(data.available))
      .catch(() => {});

    // Fetch all agents for swipe navigation
    apiGet<Agent[]>('/agents')
      .then(setAllAgents)
      .catch(() => {});

    // Fetch artifacts for this agent
    apiGet<{ id: string; filename: string; mime_type: string; size_bytes: number; created_at: string; note?: string }[]>(`/artifacts?agent_id=${id}`)
      .then(setAgentArtifacts)
      .catch(() => {});

    return () => {
      if (outputRefreshTimerRef.current) {
        clearTimeout(outputRefreshTimerRef.current);
        outputRefreshTimerRef.current = null;
      }
      queuedOutputRefreshRef.current = false;
      outputRequestInFlightRef.current = false;
      pendingOutputVersionRef.current = 0;
    };
  }, [id, navigate, scheduleOutputRefresh]);

  // Auto-scroll output (only if user is near bottom)
  const isNearBottom = useRef(true);
  useEffect(() => {
    if (outputRef.current && isNearBottom.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [output]);

  // Load older scrollback when scrolling to top
  const handleOutputScroll = useCallback(() => {
    if (!outputRef.current || loadingMore || !hasMoreScrollback) return;

    const el = outputRef.current;
    // Track if user is near the bottom (for auto-scroll)
    isNearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 50;

    // Load more when scrolled to top
    if (el.scrollTop < 30) {
      setLoadingMore(true);
      const nextEnd = -(scrollbackLoaded);
      const nextStart = nextEnd - 200;

      apiGet<{ html: string; hasMore: boolean }>(`/agents/${id}/scrollback?start=${nextStart}&end=${nextEnd}`)
        .then((data) => {
          if (data.html.trim()) {
            setOlderHtml((prev) => data.html + prev);
            setScrollbackLoaded((prev) => prev + 200);
            setHasMoreScrollback(data.hasMore);
            // Maintain scroll position after prepending
            requestAnimationFrame(() => {
              if (el) el.scrollTop = 100;
            });
          } else {
            setHasMoreScrollback(false);
          }
        })
        .catch(() => {})
        .finally(() => setLoadingMore(false));
    }
  }, [id, loadingMore, hasMoreScrollback, scrollbackLoaded]);

  // Reset scrollback state when switching agents
  useEffect(() => {
    setOlderHtml('');
    setScrollbackLoaded(100);
    setHasMoreScrollback(true);
    isNearBottom.current = true;
    outputVersionRef.current = 0;
    pendingOutputVersionRef.current = 0;
  }, [id]);

  // SSE updates
  const handleSSE = useCallback(
    (event: SSEEvent) => {
      if (event.entityId !== id) return;

      if (event.type === 'agent.detached') {
        navigate('/');
        return;
      }

      if (event.type === 'agent.status_changed' || event.type === 'agent.output_updated') {
        setAgent((prev) =>
          prev
            ? {
                ...prev,
                status:
                  (event.payload?.status as Agent['status']) ?? prev.status,
                lastOutputLine:
                  (event.payload?.lastOutputLine as string) ??
                  prev.lastOutputLine,
                outputVersion:
                  (event.payload?.outputVersion as number) ??
                  prev.outputVersion,
              }
            : prev,
        );
      }

      const eventOutputVersion = typeof event.payload?.outputVersion === 'number'
        ? event.payload.outputVersion
        : null;

      if (
        eventOutputVersion !== null &&
        eventOutputVersion > Math.max(outputVersionRef.current, pendingOutputVersionRef.current)
      ) {
        pendingOutputVersionRef.current = eventOutputVersion;
        scheduleOutputRefresh();
        return;
      }

      if (shouldRefreshAgentOutput(event.type)) {
        scheduleOutputRefresh();
      }
    },
    [id, navigate, scheduleOutputRefresh],
  );

  useSSE(handleSSE);

  // Enhance prompt with LLM
  const handleEnhance = async () => {
    if (!prompt.trim() || !id || enhancing) return;
    setEnhancing(true);
    try {
      const result = await apiPost<{ enhanced: string }>('/enhance', {
        prompt,
        agentId: id,
      });
      if (result.enhanced) {
        setPrompt(result.enhanced);
        setPromptExpanded(true);
        // Focus and select all so user can review
        setTimeout(() => {
          if (textareaRef.current) {
            textareaRef.current.focus();
            textareaRef.current.scrollTop = 0;
          }
        }, 50);
      }
    } catch {
      // enhance failed
    } finally {
      setEnhancing(false);
    }
  };

  // Upload file and attach to prompt
  const handleFileUpload = async (file: File) => {
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      if (id) formData.append('agent_id', id);
      const artifact = await apiUpload<{ id: string; filename: string; storage_path: string; attached_path?: string }>('/artifacts/upload', formData);
      if (artifact?.id) {
        setAttachedFiles((prev) => [...prev, {
          name: artifact.filename,
          path: artifact.attached_path ?? artifact.storage_path,
        }]);
        // Refresh artifacts list
        if (id) {
          apiGet<{ id: string; filename: string; mime_type: string; size_bytes: number; created_at: string; note?: string }[]>(`/artifacts?agent_id=${id}`)
            .then(setAgentArtifacts)
            .catch(() => {});
        }
      }
    } catch {
      // upload failed
    } finally {
      setUploading(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) handleFileUpload(file);
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData.items;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) {
          const named = new File([file], `screenshot-${Date.now()}.png`, { type: file.type });
          handleFileUpload(named);
        }
        return;
      }
    }
  };

  const buildPromptWithAttachments = (basePrompt: string) => {
    if (attachedFiles.length === 0) return basePrompt;
    const fileRefs = attachedFiles.map((f) => `[Attached: ${f.name} → ${f.path}]`).join('\n');
    return `${basePrompt}\n\n${fileRefs}`;
  };

  // Send prompt — DIRECT to terminal or AI mode via Chat LLM
  const handleSend = async () => {
    if (!prompt.trim() || !id || sending) return;
    setSending(true);
    setAiResponse('');
    try {
      if (promptMode === 'ai') {
        // AI mode: send through Chat LLM with agent context
        const aiPrompt = prompt.includes('@')
          ? prompt
          : `[Context: viewing agent ${agent?.name}] ${prompt}`;
        const result = await apiPost<{ reply: string; toolCalls: string[] }>('/chat/send', {
          message: buildPromptWithAttachments(aiPrompt),
        });
        setAiResponse(result.reply);
        setPrompt('');
        setAttachedFiles([]);
      } else {
        // DIRECT mode: send to agent terminal
        await apiPost(`/agents/${id}/send`, { text: buildPromptWithAttachments(prompt) });
        setPrompt('');
        setAttachedFiles([]);
      }
      // Refresh output immediately after sending, then again after a short delay
      // so the user sees their command appear in the terminal
      scheduleOutputRefresh(250);
      setTimeout(() => {
        scheduleOutputRefresh();
      }, 2000);
    } catch {
      // Send failed
    } finally {
      setSending(false);
    }
  };

  // Swipe navigation between agents
  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX;
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    touchEndX.current = e.changedTouches[0].clientX;
    const diff = touchStartX.current - touchEndX.current;
    const minSwipe = 80;

    if (Math.abs(diff) < minSwipe || allAgents.length < 2) return;

    const currentIdx = allAgents.findIndex((a) => a.id === id);
    if (currentIdx === -1) return;

    if (diff > 0 && currentIdx < allAgents.length - 1) {
      // Swipe left → next agent
      navigate(`/agent/${allAgents[currentIdx + 1].id}`);
    } else if (diff < 0 && currentIdx > 0) {
      // Swipe right → previous agent
      navigate(`/agent/${allAgents[currentIdx - 1].id}`);
    }
  };

  // Runtime-specific quick commands
  function getQuickCommands(runtime: string): { command: string; label: string }[] {
    switch (runtime) {
      case 'claude-code':
        return [
          { command: '/status', label: 'Status' },
          { command: '/compact', label: 'Compact' },
          { command: '/clear', label: 'Clear' },
          { command: '/cost', label: 'Cost' },
          { command: '/help', label: 'Help' },
          { command: '/review', label: 'Review' },
          { command: '/init', label: 'Init' },
        ];
      case 'codex':
        return [
          { command: '/status', label: 'Status' },
          { command: '/help', label: 'Help' },
          { command: '/diff', label: 'Diff' },
          { command: '/model', label: 'Model' },
          { command: '/undo', label: 'Undo' },
          { command: '/clear', label: 'Clear' },
        ];
      case 'aider':
        return [
          { command: '/help', label: 'Help' },
          { command: '/diff', label: 'Diff' },
          { command: '/undo', label: 'Undo' },
          { command: '/clear', label: 'Clear' },
          { command: '/tokens', label: 'Tokens' },
          { command: '/map', label: 'Map' },
          { command: '/run', label: 'Run' },
        ];
      default:
        return [
          { command: '/help', label: 'Help' },
          { command: '/status', label: 'Status' },
        ];
    }
  }

  if (!agent) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center">
        <div className="text-[10px] text-slate-600 tracking-[0.3em] uppercase animate-pulse">
          Loading...
        </div>
      </div>
    );
  }

  return (
    <div
      className="min-h-screen bg-slate-950 flex flex-col"
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      {/* Header */}
      <header className="sticky top-0 z-40 border-b border-slate-800/60 bg-slate-950/90 backdrop-blur-xl">
        <div className="max-w-3xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3 min-w-0">
            <button
              onClick={() => navigate('/')}
              className="text-slate-500 hover:text-slate-300 transition-colors text-sm flex-shrink-0"
            >
              &larr;
            </button>
            <div className="min-w-0">
              <h1 className="text-sm font-bold text-slate-100 truncate">
                {agent.name}
              </h1>
              <p className="text-[10px] text-slate-600 tracking-wide uppercase">
                {agent.runtime} &middot; {agent.tmux_session}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {/* Swipe dots */}
            {allAgents.length > 1 && (
              <div className="hidden sm:flex items-center gap-1 mr-2">
                {allAgents.map((a) => (
                  <button
                    key={a.id}
                    onClick={() => navigate(`/agent/${a.id}`)}
                    className={`w-1.5 h-1.5 rounded-full transition-all ${
                      a.id === id ? 'bg-emerald-400 w-3' : 'bg-slate-700 hover:bg-slate-600'
                    }`}
                  />
                ))}
              </div>
            )}
            <StatusBadge status={agent.status} />
          </div>
        </div>
      </header>

      {/* Agent info bar */}
      <div className="border-b border-slate-800/30 bg-slate-900/30">
        <div className="max-w-3xl mx-auto px-4 py-2 flex items-center gap-4 text-[10px] text-slate-600 tracking-wider">
          <span>
            MODE:{' '}
            <span className="text-slate-400 uppercase">{agent.mode}</span>
          </span>
          <span>
            SESSION:{' '}
            <span className="text-slate-400 font-mono">
              {agent.tmux_session}
            </span>
          </span>
          {agent.workspace && (
            <span className="hidden sm:inline">
              DIR:{' '}
              <span className="text-slate-400 font-mono">
                {agent.workspace}
              </span>
            </span>
          )}
        </div>
      </div>

      {/* Output */}
      <main className="flex-1 max-w-3xl mx-auto w-full px-4 py-4">
        <div className="rounded-lg border border-slate-800/50 bg-black/40 overflow-hidden">
          <div className="px-3 py-1.5 border-b border-slate-800/30 flex items-center justify-between">
            <span className="text-[9px] text-slate-600 tracking-[0.2em] uppercase">
              Captured Output
            </span>
            <span className="text-[9px] text-slate-700 font-mono flex items-center gap-1.5">
              <span className="w-1 h-1 rounded-full bg-emerald-500 animate-pulse" />
              live &middot; 100 lines
            </span>
          </div>
          <div
            ref={outputRef as React.RefObject<HTMLDivElement | null>}
            onScroll={handleOutputScroll}
            className="p-3 text-[11px] leading-[1.6] text-slate-400 font-mono overflow-x-auto overflow-y-auto max-h-[70vh] min-h-[300px] whitespace-pre-wrap break-words terminal-output"
          >
            {/* Loading more indicator */}
            {loadingMore && (
              <div className="text-center py-2 text-[9px] text-slate-600 tracking-wider animate-pulse">
                LOADING HISTORY...
              </div>
            )}
            {hasMoreScrollback && !loadingMore && olderHtml && (
              <div className="text-center py-1 text-[9px] text-slate-700 tracking-wider">
                ↑ SCROLL UP FOR MORE
              </div>
            )}
            {/* Older scrollback content */}
            {olderHtml && (
              <div dangerouslySetInnerHTML={{ __html: sanitizeHtml(olderHtml) }} />
            )}
            {/* Current output */}
            {outputHtml ? (
              <div dangerouslySetInnerHTML={{ __html: sanitizeHtml(outputHtml) }} />
            ) : (
              <pre className="whitespace-pre-wrap">
                {output || (
                  <span className="text-slate-700 italic">
                    No output captured yet.
                  </span>
                )}
              </pre>
            )}
          </div>
        </div>
      </main>

      {/* ═══ GUIDES — attached reference docs ═══ */}
      {id && <AgentGuidesBar agentId={id} />}

      {/* ═══ DECISIONS — architectural decisions for this workspace ═══ */}
      {id && <DecisionsBar agentId={id} />}

      {/* ═══ ARTIFACTS — files attached to this agent ═══ */}
      {agentArtifacts.length > 0 && (
        <div className="border-t border-violet-500/20 bg-violet-950/10">
          <div className="max-w-3xl mx-auto px-4 py-2">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[9px] text-violet-500/70 font-bold tracking-wider">ARTIFACTS</span>
              <span className="text-[9px] text-slate-600">{agentArtifacts.length}</span>
              {agentArtifacts.slice(0, 10).map((a) => {
                const isImage = a.mime_type.startsWith('image/');
                const sizeLabel = a.size_bytes < 1024 ? `${a.size_bytes}B`
                  : a.size_bytes < 1048576 ? `${(a.size_bytes / 1024).toFixed(1)}KB`
                  : `${(a.size_bytes / 1048576).toFixed(1)}MB`;
                return (
                  <a
                    key={a.id}
                    href={`/api/artifacts/${a.id}/download`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-violet-950/50 border border-violet-500/30 text-[9px] text-violet-300 font-mono hover:border-violet-400/60 hover:text-violet-200 transition-colors"
                    title={a.note ?? a.filename}
                  >
                    {isImage ? '🖼' : '📎'} {a.filename.length > 25 ? a.filename.substring(0, 22) + '...' : a.filename}
                    <span className="text-[8px] text-slate-500">{sizeLabel}</span>
                  </a>
                );
              })}
              {agentArtifacts.length > 10 && (
                <span className="text-[9px] text-slate-500">+{agentArtifacts.length - 10} more</span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ═══ DETECTED FILES — handoff bar ═══ */}
      {(() => {
        // Detect file paths mentioned in recent output
        const fileMatches = output.match(/(?:Created|Wrote|Written|Updated|Saved|Generated|Output|Committed)[:\s]+(?:to\s+)?[`"']?([\w/.~-]+\.(?:md|ts|tsx|js|json|yaml|yml|go|py|sql|spec|txt|css|html|vue|svelte|rs|rb|sh))[`"']?/gi);
        const gitFiles = output.match(/(?:create mode|modify|new file)[:\s]+\d*\s*([\w/.~-]+)/gi);

        const detected = new Set<string>();
        [fileMatches, gitFiles].forEach((matches) => {
          matches?.forEach((m) => {
            const pathMatch = m.match(/([\w/.~-]+\.(?:md|ts|tsx|js|json|yaml|yml|go|py|sql|spec|txt|css|html))/i);
            if (pathMatch) detected.add(pathMatch[1]);
          });
        });

        // Also detect any .md paths mentioned anywhere in output
        for (const mdPath of extractMdPaths(output)) {
          detected.add(mdPath);
        }

        const files = [...detected].slice(0, 8);
        if (files.length === 0) return null;

        return (
          <div className="border-t border-cyan-500/20 bg-cyan-950/20">
            <div className="max-w-3xl mx-auto px-4 py-2">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[9px] text-cyan-500/70 font-bold tracking-wider">FILES</span>
                {files.map((file) => {
                  const isMd = file.endsWith('.md');
                  const mdSlug = isMd && id ? createAgentDocSlug(id, file) : null;
                  return (
                    <span key={file} className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-cyan-950/50 border border-cyan-500/30 text-[9px] text-cyan-300 font-mono">
                      {isMd ? '📄' : '◻'} {file.length > 30 ? '...' + file.slice(-27) : file}
                      {agent?.name && (
                        <span className="text-[8px] text-violet-400/70">{agent.name}</span>
                      )}
                      {isMd && mdSlug && (
                        <button
                          onClick={() => navigate(`/docs/${mdSlug}`)}
                          className="px-1 text-emerald-400 hover:text-emerald-200 font-bold"
                          title={`Open ${file} in docs viewer`}
                        >
                          OPEN
                        </button>
                      )}
                      <button
                        onClick={() => {
                          setPrompt(`Read the file ${file} and `);
                          textareaRef.current?.focus();
                        }}
                        className="text-cyan-400 hover:text-cyan-200"
                        title="Use this file in a prompt"
                      >
                        →
                      </button>
                    </span>
                  );
                })}
                {allAgents.length > 1 && (
                  <select
                    onChange={async (e) => {
                      const targetId = e.target.value;
                      if (!targetId) return;
                      const targetAgent = allAgents.find((a) => a.id === targetId);
                      const fileList = files.join(', ');
                      try {
                        await apiPost(`/agents/${targetId}/send`, {
                          text: `Read and review these files from ${agent.name}: ${fileList}. They were just created/updated. Analyze them and provide feedback or implement based on their content.`
                        });
                      } catch {}
                      e.target.value = '';
                    }}
                    className="px-2 py-0.5 rounded bg-cyan-950 border border-cyan-500/30 text-[9px] text-cyan-300 font-mono focus:outline-none"
                  >
                    <option value="">HANDOFF TO...</option>
                    {allAgents.filter((a) => a.id !== id).map((a) => (
                      <option key={a.id} value={a.id}>{a.name}</option>
                    ))}
                  </select>
                )}
              </div>
            </div>
          </div>
        );
      })()}

      {/* ═══ REVIEW ACTIONS — inline in agent view ═══ */}
      {agent.status === 'idle' && output.length > 100 && (
        <div className="border-t border-slate-700/50 bg-slate-900/80">
          <div className="max-w-3xl mx-auto px-4 py-2 flex items-center gap-2">
            <span className="text-[9px] text-slate-500 font-bold tracking-wider mr-1">REVIEW</span>
            <button
              onClick={async () => {
                try {
                  await apiPost(`/agents/${id}/send`, {
                    text: 'Review your recent changes critically. Check for bugs, security issues, missing error handling, and missing tests. Start with "REVIEW:" and list any issues found with severity [HIGH/MED/LOW]. If everything looks good, say "REVIEW PASS: no issues found."'
                  });
                } catch {}
              }}
              className="px-2.5 py-1 rounded bg-slate-800 border border-slate-600/50 text-[10px] font-bold text-slate-300 hover:bg-slate-700 hover:border-slate-500 transition-all active:scale-95"
            >
              SELF REVIEW
            </button>
            <button
              onClick={async () => {
                try {
                  // Use the LLM API to review the agent's output/diff directly
                  const outputData = await apiGet<{ output: string }>(`/agents/${id}/output?lines=50`);
                  await apiPost('/chat/send', {
                    message: `Do a cross-model review of ${agent.name}'s recent work. Capture the diff and review it for bugs, security, and quality.`
                  });
                } catch {}
              }}
              className="px-2.5 py-1 rounded bg-violet-950 border border-violet-500/40 text-[10px] font-bold text-violet-300 hover:bg-violet-900 hover:border-violet-400 transition-all active:scale-95"
            >
              ✦ CROSS-MODEL
            </button>
            <button
              onClick={async () => {
                try {
                  await apiPost(`/agents/${id}/send`, {
                    text: 'Run the test suite for the files you just changed. Report which tests pass and which fail.'
                  });
                } catch {}
              }}
              className="px-2.5 py-1 rounded bg-emerald-950 border border-emerald-500/40 text-[10px] font-bold text-emerald-300 hover:bg-emerald-900 hover:border-emerald-400 transition-all active:scale-95"
            >
              RUN TESTS
            </button>
            <button
              onClick={async () => {
                try {
                  await apiPost(`/agents/${id}/send`, {
                    text: 'Show me a git diff of all your recent changes. Use git diff HEAD.'
                  });
                } catch {}
              }}
              className="px-2.5 py-1 rounded bg-cyan-950 border border-cyan-500/40 text-[10px] font-bold text-cyan-300 hover:bg-cyan-900 hover:border-cyan-400 transition-all active:scale-95"
            >
              SHOW DIFF
            </button>
          </div>
        </div>
      )}

      {/* ═══ DETECTED PROMPT — auto-answer bar ═══ */}
      {(() => {
        // Detect CLI choice prompts in the last 15 lines of output
        const lines = output.split('\n').slice(-15);
        const choices: { num: string; label: string }[] = [];
        let promptQuestion = '';

        for (const line of lines) {
          // Match patterns like "1. Yes", "2. Yes, allow...", "> 1. Yes", "› 1. Yes"
          const choiceMatch = line.match(/^\s*[›>]?\s*(\d+)\.\s+(.+)$/);
          if (choiceMatch) {
            choices.push({ num: choiceMatch[1], label: choiceMatch[2].trim() });
          }
          // Match question lines
          const questionMatch = line.match(/(?:Do you want|Would you like|Select|Choose|Proceed|Continue)\s*.*\?/i);
          if (questionMatch) {
            promptQuestion = questionMatch[0];
          }
        }

        if (choices.length < 2) return null;

        return (
          <div className="border-t-2 border-amber-500/40 bg-amber-950/30 px-4 py-2">
            <div className="max-w-3xl mx-auto">
              {promptQuestion && (
                <p className="text-[10px] text-amber-300 font-mono mb-1.5 truncate">{promptQuestion}</p>
              )}
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-[9px] text-amber-500/70 font-bold tracking-wider mr-1">RESPOND:</span>
                {choices.map((choice, choiceIdx) => (
                  <button
                    key={choice.num}
                    onClick={async () => {
                      try {
                        // TUI selectors need arrow keys, not typed numbers
                        // Send Down arrow (choiceIdx times) then Enter as raw keys
                        for (let i = 0; i < choiceIdx; i++) {
                          await apiPost(`/agents/${id}/send`, { text: 'Down', raw: true });
                        }
                        await apiPost(`/agents/${id}/send`, { text: 'Enter', raw: true });
                      } catch {}
                    }}
                    className={`
                      px-2.5 py-1 rounded text-[10px] font-bold transition-all active:scale-95
                      ${choice.label.toLowerCase().startsWith('yes') && choice.label.includes('session')
                        ? 'bg-emerald-900 border border-emerald-400/60 text-emerald-200 hover:bg-emerald-800 shadow-[0_0_8px_rgba(16,185,129,0.2)]'
                        : choice.label.toLowerCase().startsWith('yes')
                          ? 'bg-emerald-950 border border-emerald-500/40 text-emerald-300 hover:bg-emerald-900'
                          : choice.label.toLowerCase().startsWith('no')
                            ? 'bg-red-950 border border-red-500/40 text-red-300 hover:bg-red-900'
                            : 'bg-slate-800 border border-slate-600/50 text-slate-200 hover:bg-slate-700'
                      }
                    `}
                  >
                    {choice.num}. {choice.label.length > 35 ? choice.label.substring(0, 32) + '...' : choice.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        );
      })()}

      {/* ═══ COMMAND CONSOLE ═══ */}
      <div className="sticky bottom-0 border-t-2 border-slate-700/80 bg-slate-900 shadow-[0_-4px_20px_rgba(0,0,0,0.5)]">
        <div className="max-w-3xl mx-auto px-4 py-2 space-y-1.5">

          {/* Quick commands — single compact row with controls */}
          <div className="flex items-center gap-1 overflow-x-auto">
            <span className="text-[10px] text-slate-400 tracking-wider flex-shrink-0 mr-1 font-bold">/</span>
            {getQuickCommands(agent.runtime).map((cmd) => (
              <button
                key={cmd.command}
                onClick={() => { setPrompt(cmd.command); }}
                onDoubleClick={async () => {
                  setSending(true);
                  try { await apiPost(`/agents/${id}/send`, { text: cmd.command }); }
                  catch {} finally { setSending(false); }
                }}
                title={`${cmd.label} — click to fill, double-click to send`}
                className="flex-shrink-0 px-2.5 py-1 rounded bg-slate-800 border border-slate-600/50 text-[10px] font-mono text-slate-200 hover:bg-slate-700 hover:border-slate-500 hover:text-white active:scale-95 transition-all"
              >
                {cmd.command}
              </button>
            ))}

            {/* Control keys — vivid colors */}
            <div className="border-l border-slate-600/50 ml-2 pl-2 flex gap-1.5">
              <button
                onClick={async () => {
                  try { await apiPost(`/agents/${id}/send`, { text: 'C-c', raw: true }); } catch {}
                }}
                title="Send Ctrl+C (interrupt)"
                className="flex-shrink-0 px-2.5 py-1 rounded bg-red-950 border border-red-500/60 text-[10px] font-mono font-bold text-red-300 hover:bg-red-900 hover:border-red-400 hover:text-red-200 active:scale-95 transition-all shadow-[0_0_8px_rgba(239,68,68,0.15)]"
              >
                ^C
              </button>
              <button
                onClick={async () => {
                  try { await apiPost(`/agents/${id}/send`, { text: 'Escape', raw: true }); } catch {}
                }}
                title="Send Escape"
                className="flex-shrink-0 px-2.5 py-1 rounded bg-amber-950 border border-amber-500/60 text-[10px] font-mono font-bold text-amber-300 hover:bg-amber-900 hover:border-amber-400 hover:text-amber-200 active:scale-95 transition-all shadow-[0_0_8px_rgba(245,158,11,0.15)]"
              >
                Esc
              </button>
              <button
                onClick={async () => {
                  try { await apiPost(`/agents/${id}/send`, { text: 'y' }); } catch {}
                }}
                title="Send 'y' + Enter (confirm)"
                className="flex-shrink-0 px-2.5 py-1 rounded bg-emerald-950 border border-emerald-500/60 text-[10px] font-mono font-bold text-emerald-300 hover:bg-emerald-900 hover:border-emerald-400 hover:text-emerald-200 active:scale-95 transition-all shadow-[0_0_8px_rgba(16,185,129,0.15)]"
              >
                Yes
              </button>
            </div>
          </div>

          {/* Attached files */}
          {attachedFiles.length > 0 && (
            <div className="flex items-center gap-1 flex-wrap">
              {attachedFiles.map((f, i) => (
                <span key={i} className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-violet-900/50 border border-violet-400/40 text-[9px] text-violet-200 font-mono">
                  📎 {f.name.length > 20 ? f.name.substring(0, 17) + '...' : f.name}
                  <button onClick={() => setAttachedFiles((prev) => prev.filter((_, j) => j !== i))} className="text-violet-400 hover:text-violet-200 font-bold">&times;</button>
                </span>
              ))}
              {uploading && <span className="text-[9px] text-amber-400 animate-pulse">uploading...</span>}
            </div>
          )}

          {/* AI response (when in AI mode) */}
          {aiResponse && (
            <div className="border-t border-violet-500/20 bg-violet-950/10 px-4 py-2 max-h-[200px] overflow-y-auto">
              <div className="max-w-3xl mx-auto">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[9px] text-violet-400 font-bold tracking-wider">AI RESPONSE</span>
                  <button onClick={() => setAiResponse('')} className="text-[9px] text-slate-600 hover:text-slate-400">&times;</button>
                </div>
                <p className="text-[11px] text-slate-300 font-mono whitespace-pre-wrap leading-relaxed">{aiResponse}</p>
              </div>
            </div>
          )}

          {/* Input area */}
          <div
            className="space-y-1.5"
            onDragOver={(e) => e.preventDefault()}
            onDrop={handleDrop}
          >
            {/* Hidden file input */}
            <input ref={fileInputRef} type="file" accept="image/*,.txt,.md,.json,.ts,.tsx,.js,.py,.diff,.patch,.log"
              onChange={(e) => { const file = e.target.files?.[0]; if (file) handleFileUpload(file); e.target.value = ''; }}
              className="hidden" />

            {/* Textarea — full width */}
            <textarea
              ref={textareaRef}
              value={prompt}
              onPaste={handlePaste}
              onChange={(e) => { setPrompt(e.target.value); if (!e.target.value.trim()) setPromptExpanded(false); }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
                if (e.key === 'Escape') setPromptExpanded(false);
              }}
              rows={promptExpanded ? Math.min(Math.max(prompt.split('\n').length + 1, 8), 20) : 1}
              placeholder={promptMode === 'ai' ? 'AI mode — use @agent to coordinate, ask questions...' : 'Direct — sends to agent terminal...'}
              className={`
                w-full px-3 py-1.5 rounded-lg border-2 border-slate-600/60
                bg-slate-800/80 text-sm text-slate-100 font-mono
                placeholder:text-slate-500 resize-none
                focus:outline-none focus:border-emerald-400/60 focus:ring-2 focus:ring-emerald-400/15
                transition-all duration-200
                ${promptExpanded ? 'leading-relaxed max-h-[50vh]' : ''}
              `}
              style={promptExpanded ? { minHeight: '200px' } : undefined}
            />

            {/* Action buttons — row below textarea */}
            <div className="flex items-center gap-1.5">
              {/* Mode toggle: DIRECT / AI */}
              <button
                onClick={() => setPromptMode(promptMode === 'direct' ? 'ai' : 'direct')}
                className={`px-2.5 py-1 rounded border text-[9px] font-bold tracking-wider transition-all active:scale-95 ${
                  promptMode === 'ai'
                    ? 'bg-violet-900 border-violet-400/60 text-violet-200 shadow-[0_0_8px_rgba(139,92,246,0.2)]'
                    : 'bg-slate-800 border-slate-600/50 text-slate-400 hover:text-slate-200'
                }`}
                title={promptMode === 'ai' ? 'AI mode: sends through LLM with @mentions' : 'Direct mode: sends to agent terminal'}
              >
                {promptMode === 'ai' ? '✦ AI' : 'DIRECT'}
              </button>
              <button
                onClick={() => setPromptExpanded(!promptExpanded)}
                className="px-2 py-1 rounded bg-slate-800 border border-slate-600/50 text-[9px] font-bold tracking-wider text-slate-400 hover:text-slate-200 hover:border-slate-500 transition-all active:scale-95"
                title={promptExpanded ? 'Collapse (Esc)' : 'Expand editor'}
              >
                {promptExpanded ? '▼ COLLAPSE' : '▲ EXPAND'}
              </button>
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                className="px-2 py-1 rounded bg-slate-800 border border-slate-600/50 text-[10px] font-bold text-slate-300 hover:bg-slate-700 hover:text-white hover:border-slate-500 transition-all active:scale-95"
                title="Attach file (drag & drop or Cmd+V)"
              >
                {uploading ? '..' : '📎 Attach'}
              </button>
              <button
                onClick={enhancerAvailable ? handleEnhance : undefined}
                disabled={enhancing || !prompt.trim() || !enhancerAvailable}
                className={`
                  px-2.5 py-1 rounded border text-[10px] font-bold tracking-wider transition-all
                  ${!enhancerAvailable ? 'bg-slate-900 border-slate-800 text-slate-700 cursor-not-allowed'
                    : enhancing || !prompt.trim() ? 'bg-violet-950/50 border-violet-500/20 text-violet-500/50 cursor-not-allowed'
                    : 'bg-violet-900 border-violet-400/60 text-violet-200 hover:bg-violet-800 hover:border-violet-300 active:scale-95 shadow-[0_0_12px_rgba(139,92,246,0.3)]'}
                `}
                title={enhancerAvailable ? 'Enhance prompt with AI' : 'Go to Settings to add your API key'}
              >
                {enhancing ? '..' : '✦ AI'}
              </button>

              {/* Send — pushed to right */}
              <button
                onClick={handleSend}
                disabled={sending || !prompt.trim()}
                className={`
                  ml-auto px-4 py-1 rounded border text-[11px] font-bold tracking-wider transition-all
                  ${sending || !prompt.trim()
                    ? 'bg-slate-900 border-slate-800 text-slate-600 cursor-not-allowed'
                    : 'bg-emerald-950 border-emerald-500/50 text-emerald-300 hover:bg-emerald-900 hover:text-emerald-200 active:scale-95 shadow-[0_0_10px_rgba(16,185,129,0.2)]'}
                `}
              >
                {sending ? '..' : 'SEND'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
