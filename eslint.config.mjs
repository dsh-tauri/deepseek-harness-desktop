import antfu from '@antfu/eslint-config'

export default antfu({
  react: true,
  ignores: ['AGENTS.*', 'docs', 'skills', 'node_modules', 'dist', '**/dist.shell/**', 'target', 'apps/desktop/src-tauri', 'apps/native/android', 'apps/native/ios', 'apps/native/.expo', 'packages/*/skills', 'packages/builtin-plugin-ui/src/client/styles/index.ts', 'apps/native/src/uniwind-types.d.ts'],
}, {
  files: ['packages/**/*.{ts,tsx,jsx,mts,cts}'],
  rules: { 'react-refresh/only-export-components': 'off' },
})
