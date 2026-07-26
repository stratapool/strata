import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Array form with an anchored pattern, not the object form. A string key
    // matches by prefix, so `blake-hash` also rewrote the shim's own
    // `blake-hash/lib` import into `<shim>.ts/lib` and the build could not
    // resolve itself.
    alias: [
      {
        // circomlibjs reaches blake-hash's browser entry, which extends a
        // readable-stream Transform purely to offer a streaming interface, and
        // readable-stream's `require('stream')` resolves to nothing here.
        // Every pedersenHash in the client threw `Stream.call` on undefined
        // because of it. The shim keeps blake-hash's own engines — same bytes
        // out — and drops the base class. Browser only; Node keeps the real
        // package, which is why the Node end-to-end tests never caught this.
        find: /^blake-hash$/,
        replacement: fileURLToPath(new URL('./src/shims/blake-hash.ts', import.meta.url)),
      },
    ],
  },
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
    // Sourcemaps were dropped to save ~20 MB, on the reasoning that the source
    // is public anyway so the maps buy nothing. That was wrong in one
    // direction: without them a production error reads "Cannot read properties
    // of undefined (reading 'call')" at a minified frame, and the only way to
    // find it is to guess at code the browser could have named exactly. On a
    // site whose largest asset is a 20 MB proving key, the bandwidth is not
    // the expensive part — the afternoon is.
    sourcemap: true,
    chunkSizeWarningLimit: 700,
  },
});
