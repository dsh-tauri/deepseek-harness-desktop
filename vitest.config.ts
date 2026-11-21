import { defineConfig } from 'vitest/config'
import heavy from './config/vitest.desktop-heavy.config'
import desktop from './config/vitest.desktop.config'
import unit from './config/vitest.unit.config'

export default defineConfig({
  test: {
    projects: [unit, desktop, heavy],
    coverage: { provider: 'v8', exclude: ['**/node_modules/**', '**/dist/**', '**/target/**', '**/*.config.*', 'apps/desktop/src-tauri/**', 'apps/native/android/**', 'apps/native/ios/**'] },
  },
})
