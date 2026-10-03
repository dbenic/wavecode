import DOMPurify from 'dompurify';
import { linkifyPathsHtml } from './paths';

const MARKDOWN_PURIFY_CONFIG = {
  ALLOWED_TAGS: ['a', 'br', 'code', 'em', 'h1', 'h2', 'h3', 'h4', 'hr', 'li', 'p', 'pre', 'strong', 'table', 'thead', 'tbody', 'tr', 'th', 'td'],
  ALLOWED_ATTR: ['class', 'href', 'rel', 'target'],
  ADD_ATTR: ['target'], // DOMPurify drops target unless added explicitly; external links open a new tab
  ALLOW_DATA_ATTR: false,
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel):|\/|#)/i,
};

const TABLE_ROW_RE = /^\s*\|.*\|\s*$/;
const TABLE_SEP_RE = /^\s*\|(\s*:?-{2,}:?\s*\|)+\s*$/;

/**
 * GFM tables (header row, `| --- |` separator, body rows) → <table>, emitted
 * on ONE line so the later newline → <br/> pass cannot break them. Runs on
 * already-escaped text, so cells carry no live HTML.
 */
function renderTables(escaped: string): string {
  const lines = escaped.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (TABLE_ROW_RE.test(lines[i]) && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1])) {
      const cells = (l: string) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const header = cells(lines[i]);
      const rows: string[][] = [];
      let j = i + 2;
      while (j < lines.length && TABLE_ROW_RE.test(lines[j]) && !TABLE_SEP_RE.test(lines[j])) {
        rows.push(cells(lines[j]));
        j++;
      }
      const th = header.map((h) => `<th class="px-2 py-1 text-left font-semibold text-slate-200 border-b border-slate-700/60">${h}</th>`).join('');
      const tb = rows.map((r) => `<tr class="align-top">${header.map((_, k) => `<td class="px-2 py-1 border-b border-slate-800/60 text-slate-300">${r[k] ?? ''}</td>`).join('')}</tr>`).join('');
      out.push(`<table class="my-2 w-full border-collapse text-[12px]"><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table>`);
      i = j - 1;
      continue;
    }
    out.push(lines[i]);
  }
  return out.join('\n');
}

export function renderMarkdown(md: string): string {
  const escaped = md
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const rawHtml = renderTables(escaped)
    .replace(/```(\w*)\n([\s\S]*?)```/g, (_match, _lang, code) =>
      `<pre class="bg-slate-900/80 border border-slate-700/40 rounded-lg p-3 my-3 overflow-x-auto text-[11px] leading-relaxed text-emerald-300/90"><code>${code.trim()}</code></pre>`)
    .replace(/`([^`]+)`/g, '<code class="bg-slate-800/80 px-1.5 py-0.5 rounded text-emerald-400/80 text-[11px]">$1</code>')
    .replace(/^#### (.+)$/gm, '<h4 class="text-sm font-bold text-slate-200 mt-5 mb-2">$1</h4>')
    .replace(/^### (.+)$/gm, '<h3 class="text-sm font-bold text-slate-100 mt-6 mb-2 border-b border-slate-800/40 pb-1">$1</h3>')
    .replace(/^## (.+)$/gm, '<h2 class="text-base font-bold text-slate-50 mt-8 mb-3 border-b border-slate-700/40 pb-1.5">$1</h2>')
    .replace(/^# (.+)$/gm, '<h1 class="text-lg font-bold text-white mt-6 mb-4">$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong class="text-slate-100 font-semibold">$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    // In-app links (`/file?path=…`, `/agent/…`) stay in the SPA — never a new tab, the token lives in memory
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, text: string, href: string) =>
      href.startsWith('/') && !href.startsWith('//')
        ? `<a href="${href}" class="text-emerald-400 hover:text-emerald-300 underline underline-offset-2">${text}</a>`
        : `<a href="${href}" class="text-emerald-400 hover:text-emerald-300 underline underline-offset-2" target="_blank" rel="noopener">${text}</a>`)
    .replace(/^---+$/gm, '<hr class="border-slate-700/40 my-6" />')
    .replace(/^(\s*)[-*] (.+)$/gm, '$1<li class="ml-4 text-slate-300 list-disc list-inside">$2</li>')
    .replace(/^(\s*)\d+[.)] (.+)$/gm, '$1<li class="ml-4 text-slate-300 list-decimal list-inside">$2</li>')
    .replace(/\n\n/g, '</p><p class="text-slate-400 text-[12px] leading-relaxed mb-3">')
    .replace(/\n/g, '<br/>');

  return String(DOMPurify.sanitize(
    `<p class="text-slate-400 text-[12px] leading-relaxed mb-3">${linkifyPathsHtml(rawHtml)}</p>`,
    MARKDOWN_PURIFY_CONFIG,
  ));
}
