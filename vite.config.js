import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  build: {
    outDir: 'www',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
  },
});
