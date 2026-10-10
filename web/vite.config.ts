import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The box this talks to while developing. Override with VITE_BOX=http://192.168.1.87 npm run dev
const BOX = process.env.VITE_BOX ?? 'http://waxcodedvs.local';

// Everything the box's HTTP API serves. Proxied in dev so the app runs on your Mac against real
// hardware; in production the app is served BY the box, so these are same-origin already.
// Derived from lib/api.ts - a prefix missing here hits the dev server instead of the box, which
// is how the PIN gate, updates, the whole Software pane and stick writes came to be broken under
// `npm run dev` while working perfectly on a box.
const API = [
  '/version', '/network', '/input-mode', '/record', '/diagnostics',
  '/library', '/favourites', '/decks', '/analysis', '/signal',
  '/pin', '/update', '/key-lock', '/support-tunnel', '/uploads', '/order', '/stick',
];

export default defineConfig({
  plugins: [react()],
  // Relative asset paths, so the build works wherever it is mounted.
  base: './',
  build: {
    // Straight into the directory the box serves. The box never builds and never runs npm install,
    // so the built files are committed; package-release.js copies server/ wholesale, which means
    // publishing needs no change at all.
    outDir: '../server/web',
    emptyOutDir: true,
    // No content hashes: this output is committed, and stable names keep the diffs readable.
    // Caching is irrelevant here - the box already sends Cache-Control: no-cache.
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
  server: {
    host: true,
    proxy: Object.fromEntries(
      API.map((path) => [path, { target: BOX, changeOrigin: true }]),
    ),
  },
});
