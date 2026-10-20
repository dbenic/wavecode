import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { codexResumeArgs, ownThreadId } from './codex-sessions.js';

function rollout(home: string, day: string, stamp: string, id: string, cwd: string, forkedFrom?: string): void {
  const dir = path.join(home, 'sessions', '2026', '10', day);
  fs.mkdirSync(dir, { recursive: true });
  // real meta lines carry base instructions and workspace roots: tens of KB on one line
  const meta = { timestamp: `2026-10-${day}T${stamp}Z`, ordinal: 0, type: 'session_meta', payload: { id, cwd, ...(forkedFrom ? { forked_from_id: forkedFrom } : {}), base_instructions: 'x'.repeat(20_000), runtime_workspace_roots: [cwd] } };
  fs.writeFileSync(path.join(dir, `rollout-2026-10-${day}T${stamp.replace(/:/g, '-')}-${id}.jsonl`), JSON.stringify(meta) + '\n' + JSON.stringify({ type: 'turn', text: 'x'.repeat(100) }) + '\n');
}

describe('codex sessions', () => {
  it('resumes the newest thread of the agent\'s own worktree, never the login\'s last thread nor a fork of someone else\'s', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-codex-home-'));
    try {
      const scout = path.join(home, 'wt', 'ultra-scout');
      const codex1 = path.join(home, 'wt', 'codex1');
      rollout(home, '19', '09:00:00', '01a10000-0000-7000-8000-000000000001', scout);
      rollout(home, '20', '08:44:44', '01a10000-0000-7000-8000-000000000002', scout);
      rollout(home, '20', '11:00:00', '01a10000-0000-7000-8000-000000000003', codex1); // the login's last thread: codex1's
      rollout(home, '20', '11:47:52', '01a10000-0000-7000-8000-000000000004', scout, '01a10000-0000-7000-8000-000000000003'); // forked from codex1's on the lock screen
      // codex1's thread was once resumed inside scout's worktree (a bad --last): the newer rollout says cwd=scout,
      // but the thread was created in codex1's directory, so it is not scout's.
      rollout(home, '20', '12:00:00', '01a10000-0000-7000-8000-000000000003', scout);
      expect(ownThreadId(home, scout)).toBe('01a10000-0000-7000-8000-000000000002');
      expect(ownThreadId(home, codex1)).toBe('01a10000-0000-7000-8000-000000000003');
      expect(codexResumeArgs(home, scout)).toBe('resume 01a10000-0000-7000-8000-000000000002');
      expect(codexResumeArgs(home, path.join(home, 'wt', 'fresh'))).toBeNull();
      expect(codexResumeArgs(home, null)).toBeNull();
      expect(codexResumeArgs(path.join(home, 'nowhere'), scout)).toBeNull();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
