/// <reference types="vitest" />
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig(({ mode }) => ({
  base: './',
  plugins: [vue()],
  resolve: {
    alias: {
      '@runtime-host': fileURLToPath(new URL(
        mode === 'plugin' ? './src/frontend/pluginEntry.ts' : './src/frontend/standaloneEntry.ts',
        import.meta.url
      ))
    }
  },
  server: { strictPort: true, host: '127.0.0.1', port: 1428 },
  build: { target: 'es2022' },
  test: { exclude: ['**/node_modules/**', '**/dist/**'] }
}));
