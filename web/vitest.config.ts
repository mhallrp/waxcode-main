import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    // Per-file, so the pure-logic tests still run in plain node and stay fast.
    environmentMatchGlobs: [['src/**/*.dom.test.*', 'jsdom']],
  },
});
