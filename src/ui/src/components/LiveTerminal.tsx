import { useEffect, useRef, useState, useCallback } from 'react';
import type { Terminal as XTerm } from '@xterm/xterm';
import { buildTerminalUrl, getAccessToken } from '../hooks/useApi';

/**
 * The agent's pane rendered by xterm.js from the server's byte stream
 * (terminal-ws.ts). Read-only: prompts go through the composer below.
 *
 * The terminal keeps the pane's own column count, so lines wrap exactly as
 * the agent sees them; the font shrinks until that many columns fit the
 * container width. Rows match the pane too, so the element is as tall as
 * the pane and the page scrolls; the wheel over the terminal scrolls its
 * scrollback, like any terminal.
 */

type Status = 'connecting' | 'live' | 'reconnecting' | 'closed' | 'unavailable';

interface Props {
  agentId: string;
  /** Called when the server refuses the stream (disabled, forbidden): the page falls back to text. */
  onUnavailable?: (reason: string) => void;
  /**
   * 'width' (default): the pane's columns fit the container width and the element is as
   * tall as the pane (the page scrolls). 'screen': columns and rows both fit the container,
   * for the full-screen page where the container is the viewport.
   */
  fit?: 'width' | 'screen';
  /** Full-screen page: no own header, the host fills its flex parent. */
  bare?: boolean;
}

interface InitMsg { t: 'init'; session: string; cols: number; rows: number; history_size: number }
interface ErrorMsg { t: 'error'; message: string }

const MIN_FONT = 5;
const MAX_FONT = 13;
const SCROLLBACK = 20000;
const CHAR_WIDTH_RATIO = 0.62; // a monospace glyph is about this many em wide
const LINE_HEIGHT = 1.1;

export default function LiveTerminal({ agentId, onUnavailable, fit = 'width', bare = false }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<Status>('connecting');
  const [geometry, setGeometry] = useState<{ cols: number; rows: number } | null>(null);
  const [behind, setBehind] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const unmountedRef = useRef(false);
  const retryRef = useRef(0);

  const fitFont = useCallback(() => {
    const term = termRef.current;
    const host = hostRef.current;
    if (!term || !host) return;
    const width = host.clientWidth;
    const height = fit === 'screen' ? host.clientHeight : 0;
    if (!width) return;
    let size = Math.floor(width / (term.cols * CHAR_WIDTH_RATIO));
    // Glyph height is about 1.2em, times xterm's lineHeight option.
    if (height) size = Math.min(size, Math.floor(height / (term.rows * 1.2 * LINE_HEIGHT)));
    size = Math.max(MIN_FONT, Math.min(MAX_FONT, size));
    term.options.fontSize = size;
    // Measure what xterm actually drew; the ratios above are only a first guess.
    for (let i = 0; i < 4; i++) {
      const screen = host.querySelector<HTMLElement>('.xterm-screen');
      if (!screen || size <= MIN_FONT) break;
      const tooWide = screen.offsetWidth > width;
      const tooTall = height > 0 && screen.offsetHeight > height;
      if (!tooWide && !tooTall) break;
      size -= 1;
      term.options.fontSize = size;
    }
  }, [fit]);

  const jumpToLive = useCallback(() => {
    termRef.current?.scrollToBottom();
    setBehind(false);
  }, []);

  useEffect(() => {
    unmountedRef.current = false;
    let closedByUs = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let observer: ResizeObserver | null = null;

    async function ensureTerminal(cols: number, rows: number): Promise<XTerm> {
      if (termRef.current) {
        const term = termRef.current;
        if (term.cols !== cols || term.rows !== rows) term.resize(cols, rows);
        term.reset();
        return term;
      }
      const [{ Terminal }] = await Promise.all([import('@xterm/xterm'), import('@xterm/xterm/css/xterm.css')]);
      const term = new Terminal({
        cols,
        rows,
        scrollback: SCROLLBACK,
        disableStdin: true,
        cursorBlink: false,
        cursorStyle: 'bar',
        allowProposedApi: true,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
        fontSize: 12,
        lineHeight: LINE_HEIGHT,
        theme: {
          background: '#070b14',
          foreground: '#cbd5e1',
          cursor: '#22d3ee',
          selectionBackground: 'rgba(34, 211, 238, 0.25)',
          black: '#0f172a', brightBlack: '#475569',
          red: '#f87171', brightRed: '#fca5a5',
          green: '#4ade80', brightGreen: '#86efac',
          yellow: '#facc15', brightYellow: '#fde047',
          blue: '#60a5fa', brightBlue: '#93c5fd',
          magenta: '#c084fc', brightMagenta: '#d8b4fe',
          cyan: '#22d3ee', brightCyan: '#67e8f9',
          white: '#e2e8f0', brightWhite: '#f8fafc',
        },
      });
      if (!hostRef.current) throw new Error('terminal host gone');
      term.open(hostRef.current);
      try {
        const { WebglAddon } = await import('@xterm/addon-webgl');
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => webgl.dispose());
        term.loadAddon(webgl);
      } catch {
        // No WebGL (older phones, software rendering): xterm's DOM renderer still works.
      }
      term.onScroll(() => {
        const b = term.buffer.active;
        setBehind(b.viewportY < b.baseY);
      });
      termRef.current = term;
      observer = new ResizeObserver(() => fitFont());
      observer.observe(hostRef.current);
      return term;
    }

    function connect(): void {
      if (unmountedRef.current) return;
      const url = buildTerminalUrl(window.location.origin, agentId, getAccessToken());
      const ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';
      socketRef.current = ws;
      setStatus(retryRef.current > 0 ? 'reconnecting' : 'connecting');
      let gotInit = false;

      ws.onmessage = (ev: MessageEvent) => {
        if (typeof ev.data === 'string') {
          let msg: InitMsg | ErrorMsg;
          try { msg = JSON.parse(ev.data); } catch { return; }
          if (msg.t === 'init') {
            gotInit = true;
            retryRef.current = 0;
            setGeometry({ cols: msg.cols, rows: msg.rows });
            void ensureTerminal(msg.cols, msg.rows).then((term) => {
              fitFont();
              setStatus('live');
              setError(null);
              term.scrollToBottom();
            }).catch((e) => {
              setError((e as Error).message);
              setStatus('unavailable');
              onUnavailable?.((e as Error).message);
            });
          } else if (msg.t === 'error') {
            setError(msg.message);
          }
          return;
        }
        const term = termRef.current;
        if (term) term.write(new Uint8Array(ev.data as ArrayBuffer));
      };

      ws.onclose = (ev: CloseEvent) => {
        socketRef.current = null;
        if (closedByUs || unmountedRef.current) return;
        // A refusal before init (401/403/404 or the server's "disabled") is final: fall back to text.
        if (!gotInit && (ev.code === 1006 || ev.code === 1008 || ev.code === 1011) && retryRef.current >= 2) {
          setStatus('unavailable');
          onUnavailable?.(error ?? 'live terminal unavailable');
          return;
        }
        retryRef.current += 1;
        setStatus('reconnecting');
        const wait = Math.min(10_000, 1000 * 2 ** Math.min(retryRef.current, 4));
        retryTimer = setTimeout(connect, wait);
      };
      ws.onerror = () => { /* onclose follows */ };
    }

    connect();

    return () => {
      unmountedRef.current = true;
      closedByUs = true;
      if (retryTimer) clearTimeout(retryTimer);
      observer?.disconnect();
      socketRef.current?.close();
      socketRef.current = null;
      termRef.current?.dispose();
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);

  useEffect(() => { fitFont(); }, [fit, fitFont]);

  return (
    <div className={bare ? 'relative flex-1 min-h-0 flex flex-col' : 'relative'} data-testid="live-terminal">
      {!bare && (
      <div className="px-3 py-1.5 border-b border-slate-800/30 flex items-center justify-between">
        <span className="text-[9px] text-slate-600 tracking-[0.2em] uppercase">Live terminal</span>
        <span className="text-[9px] text-slate-700 font-mono flex items-center gap-1.5">
          <span className={`w-1 h-1 rounded-full ${status === 'live' ? 'bg-emerald-500 animate-pulse' : status === 'unavailable' ? 'bg-red-500' : 'bg-amber-500'}`} />
          {status}{geometry ? ` · ${geometry.cols}×${geometry.rows}` : ''}
        </span>
      </div>
      )}
      {error && (
        <div className="px-3 py-1 text-[10px] text-amber-300/80 border-b border-amber-500/10">{error}</div>
      )}
      <div ref={hostRef} className={bare ? 'w-full flex-1 min-h-0 overflow-hidden bg-[#070b14] p-1' : 'w-full overflow-hidden bg-[#070b14] p-1 min-h-[300px]'} />
      {behind && (
        <button
          type="button"
          onClick={jumpToLive}
          className="sticky bottom-2 left-1/2 -translate-x-1/2 rounded-full border border-cyan-500/50 bg-slate-950/90 px-3 py-1 text-[10px] font-semibold tracking-wider text-cyan-200 shadow-lg"
        >
          ↓ live
        </button>
      )}
    </div>
  );
}
