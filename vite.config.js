import { defineConfig } from 'vite';
import { copyFileSync, existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';

function copyHighsWasm() {
  return {
    name: 'copy-highs-wasm',
    buildStart() {
      const src = resolve(__dirname, 'node_modules/highs/build/highs.wasm');
      const destDir = resolve(__dirname, 'src/public');
      const dest = resolve(destDir, 'highs.wasm');
      if (existsSync(src) && !existsSync(dest)) {
        mkdirSync(destDir, { recursive: true });
        copyFileSync(src, dest);
      }
    },
    writeBundle() {
      const src = resolve(__dirname, 'node_modules/highs/build/highs.wasm');
      const destDir = resolve(__dirname, 'dist');
      const dest = resolve(destDir, 'highs.wasm');
      if (existsSync(src) && !existsSync(dest)) {
        copyFileSync(src, dest);
      }
    },
  };
}

export default defineConfig({
  plugins: [copyHighsWasm()],
  root: 'src',
  envDir: '..',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
  optimizeDeps: {
    exclude: ['highs'],
  },
  server: {
    open: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});
