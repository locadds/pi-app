import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  root: resolve(__dirname, 'src/office-viewer'),
  base: '/viewer/',
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'packages/shared'),
    },
  },
  build: {
    outDir: resolve(__dirname, 'artifacts/office-viewer'),
    emptyOutDir: true,
    target: 'es2022',
  },
})
