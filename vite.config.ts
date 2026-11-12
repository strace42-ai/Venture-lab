import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// The UI talks to the local read-only API through this proxy (same origin, no CORS needed).
const api = { '/api': { target: `http://127.0.0.1:${process.env.API_PORT ?? 8787}`, changeOrigin: false } };

export default defineConfig({
  plugins: [react()],
  server: { host: '127.0.0.1', proxy: api },
  preview: { host: '127.0.0.1', proxy: api },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    // DB integration suites share one PostgreSQL; each uses its own schema, files run serially.
    fileParallelism: false,
  },
});
