import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/viewer/',
  build: {
    outDir: '../frontend',
    emptyOutDir: true,
    chunkSizeWarningLimit: 3500,
    rollupOptions: {
      output: {
        manualChunks: {
          'react-vendor': ['react', 'react-dom'],
          superdoc: ['superdoc'],
        },
      },
    },
  },
  server: {
    port: 3002,
    host: true,
    cors: true,
  },
  preview: {
    port: 3002,
    host: true,
    cors: true,
  },
})
