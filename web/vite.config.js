import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root,
  base: '/',
  plugins: [react()],
  build: {
    outDir: path.resolve(root, '../public'),
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
  },
  server: {
    port: 5191,
    proxy: {
      '/trpc': 'http://127.0.0.1:8756',
      '/upload': 'http://127.0.0.1:8756',
      '/socket.io': { target: 'http://127.0.0.1:8756', ws: true },
      '/healthz': 'http://127.0.0.1:8756',
    },
  },
});
