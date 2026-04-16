import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  base: '/viewer/',
  build: {
    chunkSizeWarningLimit: 3500,
    outDir: 'dist',
    rollupOptions: {
      output: {
        manualChunks: {
          'react-vendor': ['react', 'react-dom'],
          superdoc: ['superdoc']
        }
      }
    }
  },
  server: {
    port: 3002,
    host: true,
    cors: true,
    allowedHosts: ['localhost']
  },
  preview: {
    port: 3002,
    host: true,
    cors: true,
    allowedHosts: ['localhost']
  }
})
