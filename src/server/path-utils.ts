import path from 'node:path';

/**
 * Resolve a path relative to a root and reject traversal outside that root.
 */
export function resolvePathWithinRoot(root: string, candidatePath: string): string | null {
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(resolvedRoot, candidatePath);
  const relative = path.relative(resolvedRoot, resolvedPath);

  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    return resolvedPath;
  }

  return null;
}
