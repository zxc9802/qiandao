import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Keep the QR decoder with the app so a late chunk timeout cannot disable both scan paths.
  build: { rollupOptions: { output: { inlineDynamicImports: true } } },
  server: { port: 5173, proxy: { '/api': { target: 'http://127.0.0.1:3001', changeOrigin: false } } },
});
