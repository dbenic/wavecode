import DOMPurify from 'dompurify';
import { apiPost } from '../hooks/useApi';

/**
 * Turn `<pre class="diagram diagram-<lang>">source</pre>` blocks (from
 * renderMarkdown) and standalone diagram sources into SVG. Mermaid renders in
 * the browser; other languages go to POST /api/diagrams/render (Kroki on the
 * daemon's box). Every SVG is sanitized with DOMPurify's SVG profile before it
 * touches the DOM. Failures keep the source visible with the error above it.
 */

const SVG_PURIFY = { USE_PROFILES: { svg: true, svgFilters: true }, ADD_TAGS: ['style'], FORBID_TAGS: ['script', 'foreignObject'], FORBID_ATTR: ['onload', 'onclick', 'onerror'] };

let mermaidReady: Promise<typeof import('mermaid').default> | null = null;
let seq = 0;

async function mermaid() {
  if (!mermaidReady) {
    mermaidReady = import('mermaid').then((m) => {
      // No HTML labels anywhere: Mermaid would put entity/class/state names in <foreignObject>, which the
      // SVG sanitizer removes — leaving empty boxes. Plain SVG text survives sanitizing.
      m.default.initialize({
        startOnLoad: false, securityLevel: 'strict', theme: 'dark', htmlLabels: false,
        flowchart: { htmlLabels: false }, er: { useMaxWidth: true }, sequence: { useMaxWidth: true },
        fontFamily: 'ui-sans-serif, system-ui, sans-serif',
      } as Parameters<typeof m.default.initialize>[0]);
      return m.default;
    });
  }
  return mermaidReady;
}

export async function renderDiagram(lang: string, source: string): Promise<string> {
  const l = lang.toLowerCase();
  let svg: string;
  if (l === 'mermaid') {
    const m = await mermaid();
    seq += 1;
    svg = (await m.render(`wc-mermaid-${seq}`, source)).svg;
  } else {
    svg = (await apiPost<{ svg: string }>('/diagrams/render', { lang: l, source })).svg;
  }
  return String(DOMPurify.sanitize(svg, SVG_PURIFY));
}

export function sanitizeSvg(svg: string): string {
  return String(DOMPurify.sanitize(svg, SVG_PURIFY));
}

/**
 * The diagram source as the agent wrote it. renderMarkdown turns newlines into
 * <br> for display and escapes `<`/`&`, so textContent would be one long line
 * with entities decoded: rebuild from the HTML instead (br → newline, then
 * decode entities through a textarea).
 */
export function diagramSourceFromHtml(html: string): string {
  const withBreaks = html.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '');
  const ta = document.createElement('textarea');
  ta.innerHTML = withBreaks;
  return ta.value.replace(/\u00a0/g, ' ').trim();
}

/** Render every pending diagram block under `root`. Idempotent: rendered blocks are marked. */
export async function renderDiagramsIn(root: ParentNode): Promise<void> {
  const blocks = Array.from(root.querySelectorAll<HTMLElement>('pre.diagram:not([data-rendered])'));
  await Promise.all(blocks.map(async (pre) => {
    pre.setAttribute('data-rendered', 'pending');
    const lang = Array.from(pre.classList).find((c) => c.startsWith('diagram-'))?.slice('diagram-'.length) ?? 'mermaid';
    const source = diagramSourceFromHtml(pre.innerHTML);
    try {
      const svg = await renderDiagram(lang, source);
      const box = document.createElement('div');
      box.className = 'diagram-rendered my-3 overflow-x-auto rounded-lg border border-slate-800/60 bg-slate-950/60 p-3 [&_svg]:max-w-full [&_svg]:h-auto';
      box.setAttribute('data-lang', lang);
      box.innerHTML = svg;
      pre.replaceWith(box);
    } catch (e) {
      pre.setAttribute('data-rendered', 'error');
      pre.className = 'diagram-error bg-slate-900/80 border border-amber-500/30 rounded-lg p-3 my-3 overflow-x-auto text-[11px] leading-relaxed text-slate-400 whitespace-pre-wrap';
      pre.textContent = `[${lang} diagram could not be rendered: ${(e as Error).message}]\n\n${source}`;
    }
  }));
}
