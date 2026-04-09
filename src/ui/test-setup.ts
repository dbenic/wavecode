import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

type ResizeObserverGlobal = typeof globalThis & {
  ResizeObserver?: typeof ResizeObserver;
  window?: Window & typeof globalThis;
};

const globals = globalThis as ResizeObserverGlobal;

if (typeof window !== 'undefined' && !('ResizeObserver' in window)) {
  class ResizeObserverMock {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }

  globals.ResizeObserver = ResizeObserverMock as typeof ResizeObserver;
  if (globals.window) {
    Object.defineProperty(globals.window, 'ResizeObserver', {
      configurable: true,
      writable: true,
      value: ResizeObserverMock,
    });
  }
}

afterEach(() => {
  cleanup();
  const storage = globals.window?.localStorage;
  if (storage && typeof storage.clear === 'function') {
    storage.clear();
  }
});
