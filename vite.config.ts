import { defineConfig } from 'vite';

// `base: './'` : le build fonctionne tel quel sous https://<user>.github.io/<repo>/.
export default defineConfig({
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 1200 },
  server: { port: 5173, strictPort: false },
  test: { include: ['tests/**/*.test.ts'], environment: 'node' },
} as any);
