/**
 * "A path in an agent's reply is a link": absolute (or `~/`) file paths with a
 * text-ish extension become links to the in-app file viewer (`/file?path=…`),
 * which the server serves read-only from known roots.
 */

const EXT = 'md|markdown|txt|log|json|ya?ml|csv|tsv|ts|tsx|js|jsx|mjs|py|sql|sh|toml|ini|html?|css|xml|diff|patch';
// At least one directory segment, then a file name with an allowed extension.
// Not preceded by a word char, slash, quote or `=` (inside an attribute / URL), not followed by a path char.
const PATH_RE = new RegExp(`(?<![\\w/="'.-])(~?/(?:[\\w.@+-]+/)+[\\w.@+-]+\\.(?:${EXT}))(?![\\w/])`, 'g');

/** Every file path in a plain-text line, with its character offsets (the live terminal's link provider). */
export function findFilePaths(text: string): Array<{ start: number; end: number; path: string }> {
  const out: Array<{ start: number; end: number; path: string }> = [];
  for (const m of text.matchAll(PATH_RE)) {
    const path = m[1];
    const start = m.index ?? 0;
    out.push({ start, end: start + path.length, path });
  }
  return out;
}

export function fileViewHref(filePath: string): string {
  return `/file?path=${encodeURIComponent(filePath)}`;
}

/**
 * Terminals wrap long paths at a hyphen or slash: `…/2026-10-09-pd108-outgoing-line-vat-`
 * then `treatment.md` on the next line (Codex indents the continuation). Re-join such a
 * break so the whole path is one link; the visible text keeps the break out.
 */
export function joinWrappedPaths(html: string): string {
  const EXT_RE = EXT;
  return html.replace(
    new RegExp(`(/(?:[\\w.@+-]+/)*[\\w.@+-]*[-_/])(?:<br\\s*/?>|\\n)[ \\t]*([\\w.@+-]+(?:/[\\w.@+-]+)*\\.(?:${EXT_RE}))(?![\\w/])`, 'g'),
    '$1$2',
  );
}

/** Turn bare paths in already-escaped HTML into viewer links; existing anchors are left alone. */
export function linkifyPathsHtml(input: string): string {
  const html = joinWrappedPaths(input);
  const segments = html.split('</a>');
  return segments
    .map((seg, i) => {
      const open = i < segments.length - 1 ? seg.lastIndexOf('<a ') : -1;
      const head = open === -1 ? seg : seg.slice(0, open);
      const tail = open === -1 ? '' : seg.slice(open);
      return head.replace(PATH_RE, (p) =>
        `<a href="${fileViewHref(p)}" class="text-sky-300 hover:text-sky-200 underline decoration-sky-500/40 underline-offset-2 break-all">${p}</a>`) + tail;
    })
    .join('</a>');
}

/** The in-app route a clicked anchor points at, or null for external links. */
export function internalHref(target: EventTarget | null): string | null {
  const a = (target as HTMLElement | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
  if (!a) return null;
  const href = a.getAttribute('href') ?? '';
  return href.startsWith('/') && !href.startsWith('//') ? href : null;
}

/** onClick for containers rendered with dangerouslySetInnerHTML: keep in-app links inside the SPA (token lives in memory). */
export function internalLinkClickHandler(navigate: (to: string) => void) {
  return (e: { target: EventTarget | null; preventDefault: () => void }) => {
    const href = internalHref(e.target);
    if (!href) return;
    e.preventDefault();
    navigate(href);
  };
}
