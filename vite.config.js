import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [],
  root: 'src',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
  server: {
    open: true,
    // Proxy /api calls to Vercel dev server when running `vercel dev`.
    // If you run plain `vite dev` the proxy 404s and mapsService.js
    // automatically falls back to mock mode — no real API calls are made.
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});
