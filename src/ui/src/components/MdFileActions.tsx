import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiPost } from '../hooks/useApi';
import type { Agent } from '../types';
import { createAgentDocSlug, createRootDocSlug } from '../utils/docs';

interface MdFileActionsProps {
  filePath: string;
  agents: Agent[];
  /** If set, resolves file from this agent's workspace */
  agentId?: string;
}

/**
 * Extract .md file paths from text content.
 * Matches paths like docs/spec.md, CLAUDE.md, src/foo/bar.md, ./path/to.md
 */
export function extractMdPaths(text: string): string[] {
  const regex = /(?:^|\s|["'`(])([.\w/-]+\.md)\b/gi;
  const paths = new Set<string>();
  let match;
  while ((match = regex.exec(text)) !== null) {
    const p = match[1];
    // Filter out obviously non-path things
    if (p.length > 2 && !p.startsWith('--')) {
      paths.add(p);
    }
  }
  return [...paths];
}

export default function MdFileActions({ filePath, agents, agentId }: MdFileActionsProps) {
  const navigate = useNavigate();
  const [showShare, setShowShare] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [shared, setShared] = useState<string | null>(null);

  const filename = filePath.split('/').pop() ?? filePath;
  const slug = agentId ? createAgentDocSlug(agentId, filePath) : createRootDocSlug(filePath);

  const handleShare = async (agent: Agent) => {
    setSharing(true);
    try {
      await apiPost('/chat/send', {
        message: `handoff ${filePath} from cl-ops-product to ${agent.name}`,
      });
      setShared(agent.name);
      setShowShare(false);
    } catch {
      // Fallback: just send a direct instruction
      try {
        await apiPost(`/agents/${agent.id}/send`, {
          text: `Read and review the file: ${filePath}`,
        });
        setShared(agent.name);
        setShowShare(false);
      } catch { /* ignore */ }
    } finally {
      setSharing(false);
    }
  };

  return (
    <span className="inline-flex items-center gap-0.5 my-0.5">
      {/* File chip */}
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-blue-950/60 border border-blue-500/30 text-[10px] font-mono text-blue-300">
        📄 {filename}
      </span>

      {/* Open button */}
      <button
        onClick={() => navigate(`/docs/${slug}`)}
        className="px-1.5 py-0.5 rounded bg-emerald-950/60 border border-emerald-500/30 text-[9px] font-bold text-emerald-400 hover:bg-emerald-900/60 hover:text-emerald-300 transition-all"
        title={`Open ${filePath} in docs viewer`}
      >
        OPEN
      </button>

      {/* Share button */}
      <button
        onClick={() => setShowShare(!showShare)}
        className="px-1.5 py-0.5 rounded bg-violet-950/60 border border-violet-500/30 text-[9px] font-bold text-violet-400 hover:bg-violet-900/60 hover:text-violet-300 transition-all"
        title={`Share ${filePath} with an agent`}
      >
        {shared ? `✓ ${shared}` : 'SHARE'}
      </button>

      {/* Agent picker dropdown */}
      {showShare && (
        <span className="inline-flex items-center gap-0.5 flex-wrap">
          <span className="text-[8px] text-slate-600 mx-1">→</span>
          {agents.map((a) => (
            <button
              key={a.id}
              onClick={() => handleShare(a)}
              disabled={sharing}
              className="px-1.5 py-0.5 rounded bg-slate-800/80 border border-slate-700/50 text-[9px] font-mono text-slate-300 hover:text-white hover:border-violet-500/40 transition-all disabled:opacity-50"
            >
              {a.name}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}
