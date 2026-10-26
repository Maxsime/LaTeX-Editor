import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // In development the API runs on the host; Caddy plays this role in production.
    proxy: {
      '/api': 'http://localhost:3000',
      '/collab': {
        target: 'ws://localhost:3001',
        ws: true,
        rewrite: (path) => path.replace(/^\/collab/, ''),
      },
    },
  },
  build: {
    sourcemap: true,
  },
  test: {
    include: ['src/**/*.test.ts'],
  },
});
