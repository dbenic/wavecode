import path from 'node:path';
import { defineConfig } from 'vitest/config';

const uiNodeModules = path.resolve(__dirname, 'src/ui/node_modules');

export default defineConfig({
  resolve: {
    alias: {
      react: path.join(uiNodeModules, 'react'),
      'react/jsx-runtime': path.join(uiNodeModules, 'react/jsx-runtime.js'),
      'react/jsx-dev-runtime': path.join(uiNodeModules, 'react/jsx-dev-runtime.js'),
      'react-dom': path.join(uiNodeModules, 'react-dom'),
      'react-dom/client': path.join(uiNodeModules, 'react-dom/client.js'),
      'react-router-dom': path.join(uiNodeModules, 'react-router-dom'),
    },
    dedupe: ['react', 'react-dom', 'react-router-dom'],
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    testTimeout: 10000,
    setupFiles: ['src/server/test-helpers.ts'],
    environmentOptions: {
      jsdom: {
        url: 'http://localhost/',
      },
    },
  },
});
