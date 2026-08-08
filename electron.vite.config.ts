import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'

export default defineConfig({
  main: {
    build: {
      lib: { entry: 'src/main/entry.ts' },
    },
  },
  preload: {},
  renderer: {
    plugins: [react()],
  },
})
