import { defineConfig } from '@genapi/core'
import pipeline from '@genapi/pipeline'
import { ofetch } from '@genapi/presets'
import { original } from 'dsh-h3/genapi'

const plugins = [
  'dsh-tauri-extension',
  'dsh-tauri-scheduler',
  'dsh-tauri-rightclick',
  'dsh-tauri-archive',
  'dsh-tauri-experimental',
  'dsh-tauri-model',
  'dsh-tauri-ui',
  'dsh-tauri-notification',
  'dsh-tauri-worktree',
  'dsh-tauri-ssh',
]

export default defineConfig({
  preset: pipeline(
    (config) => {
      const read = ofetch.ts.config(config)
      for (const entry of read.graphs.scopes.main.imports) {
        if (entry.value === 'ofetch') {
          entry.value = read.config.meta!.import!.http!
          entry.type = true
        }
      }
      return read
    },
    original,
    ofetch.ts.parser,
    ofetch.ts.compiler,
    ofetch.ts.generate,
    ofetch.ts.dest,
  ),
  meta: { import: { http: 'dsh-tauri/client' } },
  transform: {
    operation: name => name.replace(/ApiTauri(?:Extension|Scheduler|Rightclick|Archive|Experimental|Model|Ui|Notification|Worktree|Ssh)/, ''),
  },
  patch: { operations: { post: 'postWorktree', delete: 'deleteWorktree' } },
  servers: [
    ...plugins.map(plugin => ({
      input: `packages/${plugin}/src/host/server/index.ts`,
      output: {
        main: `packages/${plugin}/src/client/apis/index.ts`,
        type: `packages/${plugin}/src/client/apis/index.type.ts`,
      },
    })),
    {
      input: 'packages/dsh-tauri-ssh/src/host/server/index.ts',
      output: { main: 'src/apis/remote.ts', type: 'src/apis/remote.types.ts' },
      meta: { import: { http: './http' } },
    },
  ],
})
