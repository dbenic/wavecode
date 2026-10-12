/**
 * Shared test helpers for WaveCode server tests.
 * This file is loaded before each test suite via vitest setupFiles.
 */

import { afterEach, vi } from 'vitest';

// This environment signs every commit and turns on fsmonitor. Test repos
// commit in parallel, and the signing helper then blocks a later `git commit`
// until the test times out. Tests never want a signature.
const gitConfigBase = Number(process.env.GIT_CONFIG_COUNT ?? '0');
const gitConfigStart = Number.isFinite(gitConfigBase) ? gitConfigBase : 0;
process.env.GIT_CONFIG_COUNT = String(gitConfigStart + 2);
process.env[`GIT_CONFIG_KEY_${gitConfigStart}`] = 'commit.gpgsign';
process.env[`GIT_CONFIG_VALUE_${gitConfigStart}`] = 'false';
process.env[`GIT_CONFIG_KEY_${gitConfigStart + 1}`] = 'core.fsmonitor';
process.env[`GIT_CONFIG_VALUE_${gitConfigStart + 1}`] = 'false';

// Clean up mocks after each test
afterEach(() => {
  vi.restoreAllMocks();
});
