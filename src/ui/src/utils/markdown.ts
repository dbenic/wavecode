import DOMPurify from 'dompurify';

const MARKDOWN_PURIFY_CONFIG = {
  ALLOWED_TAGS: ['a', 'br', 'code', 'em', 'h1', 'h2', 'h3', 'h4', 'hr', 'li', 'p', 'pre', 'strong'],
  ALLOWED_ATTR: ['class', 'href', 'rel', 'target'],
  ALLOW_DATA_ATTR: false,
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel):|\/|#)/i,
};

export function renderMarkdown(md: string): string {
  const rawHtml = md
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/```(\w*)\n([\s\S]*?)```/g, (_match, _lang, code) =>
      `<pre class="bg-slate-900/80 border border-slate-700/40 rounded-lg p-3 my-3 overflow-x-auto text-[11px] leading-relaxed text-emerald-300/90"><code>${code.trim()}</code></pre>`)
    .replace(/`([^`]+)`/g, '<code class="bg-slate-800/80 px-1.5 py-0.5 rounded text-emerald-400/80 text-[11px]">$1</code>')
    .replace(/^#### (.+)$/gm, '<h4 class="text-sm font-bold text-slate-200 mt-5 mb-2">$1</h4>')
    .replace(/^### (.+)$/gm, '<h3 class="text-sm font-bold text-slate-100 mt-6 mb-2 border-b border-slate-800/40 pb-1">$1</h3>')
    .replace(/^## (.+)$/gm, '<h2 class="text-base font-bold text-slate-50 mt-8 mb-3 border-b border-slate-700/40 pb-1.5">$1</h2>')
    .replace(/^# (.+)$/gm, '<h1 class="text-lg font-bold text-white mt-6 mb-4">$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong class="text-slate-100 font-semibold">$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" class="text-emerald-400 hover:text-emerald-300 underline underline-offset-2" target="_blank" rel="noopener">$1</a>')
    .replace(/^---+$/gm, '<hr class="border-slate-700/40 my-6" />')
    .replace(/^(\s*)[-*] (.+)$/gm, '$1<li class="ml-4 text-slate-300 list-disc list-inside">$2</li>')
    .replace(/^(\s*)\d+[.)] (.+)$/gm, '$1<li class="ml-4 text-slate-300 list-decimal list-inside">$2</li>')
    .replace(/\n\n/g, '</p><p class="text-slate-400 text-[12px] leading-relaxed mb-3">')
    .replace(/\n/g, '<br/>');

  return String(DOMPurify.sanitize(
    `<p class="text-slate-400 text-[12px] leading-relaxed mb-3">${rawHtml}</p>`,
    MARKDOWN_PURIFY_CONFIG,
  ));
}
