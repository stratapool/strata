import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: '127.0.0.1',
    proxy: {
      // Same-origin in development for the same reason Caddy serves it
      // same-origin in production: a cross-origin ceremony endpoint would see
      // each contributor's IP as a separate, easily correlated request.
      '/ceremony': {
        target: 'http://127.0.0.1:8789',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/ceremony/, ''),
      },
    },
  },
  build: {
    outDir: 'dist',
    // Sourcemaps were adding 20 MB to a deploy. The source is public on
    // GitHub anyway, so shipping maps buys nothing and costs bandwidth on a
    // page users are asked to load before trusting it.
    sourcemap: false,
    chunkSizeWarningLimit: 700,
  },
});
