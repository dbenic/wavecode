/**
 * Shared test helpers for WaveCode server tests.
 * This file is loaded before each test suite via vitest setupFiles.
 */

import { afterEach, vi } from 'vitest';

// Clean up mocks after each test
afterEach(() => {
  vi.restoreAllMocks();
});
