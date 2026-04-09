/**
 * HTML sanitization for terminal output rendered via dangerouslySetInnerHTML.
 * Allows ANSI-to-HTML color spans while stripping dangerous elements.
 */
import DOMPurify from 'dompurify';

// Allow only the tags/attributes that ansi-to-html produces
const PURIFY_CONFIG = {
  ALLOWED_TAGS: ['span', 'b', 'br', 'div'],
  ALLOWED_ATTR: ['style', 'class'],
  ALLOW_DATA_ATTR: false,
};

export function sanitizeHtml(dirty: string): string {
  return String(DOMPurify.sanitize(dirty, PURIFY_CONFIG));
}
