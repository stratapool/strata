import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, host: '127.0.0.1' },
  build: {
    outDir: 'dist',
    // Sourcemaps were adding 20 MB to a deploy. The source is public on
    // GitHub anyway, so shipping maps buys nothing and costs bandwidth on a
    // page users are asked to load before trusting it.
    sourcemap: false,
    chunkSizeWarningLimit: 700,
  },
});
