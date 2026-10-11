import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

const r = (p: string) => resolve(__dirname, p)

// Main and preload see every engine module; the renderer only sees `shared`.
const nodeAliases = {
  '@shared': r('src/shared'),
  '@core': r('src/core'),
  '@data': r('src/data'),
  '@ingest': r('src/ingest'),
  '@main': r('src/main'),
  '@ai': r('src/ai'),
  '@lore': r('src/lore'),
  '@story': r('src/story'),
  '@sim': r('src/sim'),
}

export default defineConfig({
  main: {
    resolve: { alias: nodeAliases },
    build: {
      lib: { entry: r('src/main/index.ts') },
    },
  },
  preload: {
    resolve: { alias: nodeAliases },
    build: {
      rollupOptions: { input: { index: r('src/main/preload.ts') } },
    },
  },
  renderer: {
    root: r('src/renderer'),
    resolve: { alias: { '@shared': r('src/shared') } },
    plugins: [react()],
    build: {
      rollupOptions: { input: { index: r('src/renderer/index.html') } },
    },
  },
})
