import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const r = (p: string) => resolve(__dirname, p)

export default defineConfig({
  resolve: {
    alias: {
      '@shared': r('src/shared'),
      '@core': r('src/core'),
      '@data': r('src/data'),
      '@ingest': r('src/ingest'),
      '@main': r('src/main'),
      '@ai': r('src/ai'),
      '@lore': r('src/lore'),
      '@story': r('src/story'),
      '@sim': r('src/sim'),
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
