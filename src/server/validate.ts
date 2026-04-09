/**
 * Input validation helpers for API endpoints.
 * Returns `null` when valid, or an error message string.
 */

import { isValidSessionName, isAllowedRawKey } from './tmux.js';

// Max lengths to prevent abuse
const MAX_PROMPT_LENGTH = 50_000;
const MAX_NAME_LENGTH = 64;
const MAX_TEXT_LENGTH = 100_000;

export function validateAdoptBody(body: {
  sessionName?: string;
  runtime?: string;
  name?: string;
}): string | null {
  if (!body.sessionName || typeof body.sessionName !== 'string') {
    return 'sessionName is required';
  }
  if (!isValidSessionName(body.sessionName)) {
    return 'Invalid session name — use only letters, numbers, hyphens, underscores, dots';
  }
  if (!body.runtime || typeof body.runtime !== 'string') {
    return 'runtime is required';
  }
  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || body.name.length === 0 || body.name.length > MAX_NAME_LENGTH) {
      return `name must be 1-${MAX_NAME_LENGTH} characters`;
    }
    if (!/^[a-zA-Z0-9._-]+$/.test(body.name)) {
      return 'name must only contain letters, numbers, hyphens, underscores, dots';
    }
  }
  return null;
}

export function validateSendBody(body: {
  text?: string;
  raw?: boolean;
}): string | null {
  if (!body.text || typeof body.text !== 'string') {
    return 'text is required';
  }
  if (body.text.length > MAX_TEXT_LENGTH) {
    return `text exceeds maximum length (${MAX_TEXT_LENGTH} chars)`;
  }
  if (body.raw && !isAllowedRawKey(body.text)) {
    return `Invalid raw key: ${body.text}`;
  }
  return null;
}

export function validateSpawnBody(body: {
  name?: string;
  runtime?: string;
  repo?: string;
}): string | null {
  if (!body.name || typeof body.name !== 'string') {
    return 'name is required';
  }
  if (body.name.length > MAX_NAME_LENGTH) {
    return `name exceeds ${MAX_NAME_LENGTH} characters`;
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(body.name)) {
    return 'name must only contain letters, numbers, hyphens, underscores, dots';
  }
  if (!body.runtime || typeof body.runtime !== 'string') {
    return 'runtime is required';
  }
  return null;
}

export function validateTaskBody(body: {
  prompt?: string;
  agent_id?: string;
  priority?: number;
  depends_on?: string[];
}): string | null {
  if (!body.prompt || typeof body.prompt !== 'string') {
    return 'prompt is required';
  }
  if (body.prompt.length > MAX_PROMPT_LENGTH) {
    return `prompt exceeds maximum length (${MAX_PROMPT_LENGTH} chars)`;
  }
  if (body.priority !== undefined && (typeof body.priority !== 'number' || !Number.isFinite(body.priority))) {
    return 'priority must be a finite number';
  }
  if (body.depends_on !== undefined) {
    if (!Array.isArray(body.depends_on)) {
      return 'depends_on must be an array of task IDs';
    }
    if (body.depends_on.some((dep) => typeof dep !== 'string' || !dep.trim())) {
      return 'depends_on must contain non-empty task IDs';
    }
  }
  return null;
}

export function validateChatBody(body: {
  message?: string;
}): string | null {
  if (!body.message || typeof body.message !== 'string' || !body.message.trim()) {
    return 'message is required';
  }
  if (body.message.length > MAX_PROMPT_LENGTH) {
    return `message exceeds maximum length (${MAX_PROMPT_LENGTH} chars)`;
  }
  return null;
}

/**
 * Validate integer query params (for pagination, line counts, etc.)
 */
export function validateIntParam(value: string | undefined, opts: {
  min?: number;
  max?: number;
  default: number;
}): number {
  if (!value) return opts.default;
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return opts.default;
  if (opts.min !== undefined && n < opts.min) return opts.min;
  if (opts.max !== undefined && n > opts.max) return opts.max;
  return n;
}
