import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    // In dev, CelesTrak requests go through Vite so CORS never gets in the way.
    // Production builds call https://celestrak.org directly (see src/data/celestrak.ts).
    proxy: {
      '/celestrak': {
        target: 'https://celestrak.org',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/celestrak/, ''),
      },
    },
  },
  worker: { format: 'es' },
});
