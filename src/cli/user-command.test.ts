import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb, listUsers, resetDbForTest } from '../server/db.js';
import { hashToken, resolveUserByToken } from '../server/users.js';
import { addUserCommand, formatCreatedUser } from './user-command.js';

describe('wavecode user add', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wavecode-user-cli-'));
    resetDbForTest();
    initDb(path.join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    resetDbForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates a user with the requested role and prints the token once', () => {
    const result = addUserCommand('ana', { role: 'admin' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(listUsers().map((u) => [u.name, u.role])).toEqual([['ana', 'admin']]);
    expect(resolveUserByToken(result.data.token, null)?.name).toBe('ana');

    const out = formatCreatedUser(result.data);
    expect(out).toContain('ana (admin, profile ana)');
    expect(out).toContain(result.data.token);
    expect(out).not.toContain(hashToken(result.data.token));
  });

  it('sets the credential profile (default: the user name)', () => {
    const dflt = addUserCommand('ana');
    expect(dflt.ok && dflt.data.user.profile).toBe('ana');
    const custom = addUserCommand('bob', { profile: 'bob-max' });
    expect(custom.ok && custom.data.user.profile).toBe('bob-max');
    expect(addUserCommand('eve', { profile: 'Bad Name' }).ok).toBe(false);
  });

  it('defaults to developer and reports invalid roles', () => {
    const dev = addUserCommand('marko');
    expect(dev.ok && dev.data.user.role).toBe('developer');
    expect(addUserCommand('zed', { role: 'superuser' }).ok).toBe(false);
  });
});
