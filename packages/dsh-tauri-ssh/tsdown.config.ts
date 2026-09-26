import { defineConfig, dshExternal } from '../dsh-tauri-tsdown/src/index.ts'

// Host-only plugin (no client half — the settings page is dsh-tauri-ssh-ui):
// one ESM entry with dts, mirroring defineDshConfig's server half.
export default defineConfig({
  outDir: 'dist',
  format: 'esm',
  outExtensions: () => ({ js: '.js' }),
  publint: true,
  external: dshExternal,
  entry: { index: 'src/index.ts' },
  dts: true,
  sourcemap: false,
  clean: true,
})
