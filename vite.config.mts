import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // Polyfill Node.js core modules for browser
      buffer: 'buffer',
      process: 'process/browser',
      stream: 'stream-browserify',
      crypto: 'crypto-browserify',
      events: 'events',
    },
  },
  define: {
    // Define global variables
    global: 'globalThis',
    'process.env': {},
  },
  optimizeDeps: {
    // Include dependencies that need to be pre-bundled
    include: [
      'buffer',
      'process',
      'events',
      'stream-browserify',
      'crypto-browserify',
    ],
    esbuildOptions: {
      target: 'esnext',
      // Needed for proper polyfill injection
      define: {
        global: 'globalThis',
      },
    },
  },
  build: {
    target: 'esnext',
    commonjsOptions: {
      transformMixedEsModules: true,
    },
  },
});