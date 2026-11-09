/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Tauri 開發模式固定 port，見 src-tauri/tauri.conf.json
export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  build: { target: 'es2022', sourcemap: true },
  worker: { format: 'es' },
  // 測試語言固定為英文（src/test-setup.ts）
  test: { setupFiles: ['src/test-setup.ts'] },
});
