import { resolve } from 'node:path'
import { build } from 'vite'

const projectRoot = process.cwd()

await build({
  configFile: false,
  build: {
    ssr: true,
    outDir: resolve(projectRoot, 'out/office-gateway'),
    emptyOutDir: true,
    target: 'node22',
    minify: false,
    rollupOptions: {
      input: {
        index: resolve(projectRoot, 'src/office-gateway/entry.ts'),
        server: resolve(projectRoot, 'src/office-gateway/server.ts'),
      },
      output: {
        entryFileNames: '[name].mjs',
        format: 'es',
      },
    },
  },
})
