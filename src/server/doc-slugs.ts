function normalizeDocPath(filePath: string): string {
  return filePath
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '')
    .replace(/\/{2,}/g, '/');
}

function isClaudeDoc(filePath: string): boolean {
  return normalizeDocPath(filePath).toLowerCase() === 'claude.md';
}

function slugifyDocToken(value: string): string {
  const slug = normalizeDocPath(value)
    .replace(/\.md$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return slug || 'doc';
}

export function createRootDocSlug(filePath: string): string {
  if (isClaudeDoc(filePath)) return 'claude-md';

  const normalized = normalizeDocPath(filePath);
  const basename = normalized.split('/').pop() ?? normalized;
  return slugifyDocToken(basename);
}

export function createAgentDocSlug(agentId: string, filePath: string): string {
  if (isClaudeDoc(filePath)) return `agent-${agentId}-claude-md`;
  return `agent-${agentId}-${slugifyDocToken(filePath)}`;
}

export function createLegacyAgentDocSlug(agentId: string, filePath: string): string {
  if (isClaudeDoc(filePath)) return `agent-${agentId}-claude-md`;

  const normalized = normalizeDocPath(filePath);
  const basename = normalized.split('/').pop() ?? normalized;
  return `agent-${agentId}-${slugifyDocToken(basename)}`;
}
