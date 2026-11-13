import { fileURLToPath } from 'node:url'
import { defineConfig } from '@genapi/core'
import pipeline from '@genapi/pipeline'
import { ofetch } from '@genapi/presets'
import { original } from 'dsh-h3/genapi'
import { ESLint } from 'eslint'

const root = '../../'
const eslint = new ESLint({ cwd: fileURLToPath(new URL(root, import.meta.url)), fix: true })
const plugins = ['extension', 'archive', 'model', 'ui', 'notification', 'remote']

export default defineConfig({
  preset: pipeline((options) => {
    const config = ofetch.ts.config(options)
    const fetchOptions = config.graphs.scopes.main.imports.find(item => item.names?.includes('FetchOptions'))!
    fetchOptions.value = options.meta!.import!.http!
    fetchOptions.type = true
    return config
  }, original, ofetch.ts.parser, ofetch.ts.compiler, ofetch.ts.generate, async (config) => {
    for (const output of config.outputs) {
      const [result] = await eslint.lintText(output.code ?? '', { filePath: output.path })
      if (result.errorCount)
        throw new Error(JSON.stringify(result.messages))
      output.code = result.output ?? output.code
    }
    await ofetch.ts.dest(config)
  }),
  meta: { import: { http: 'dsh-tauri/client' } },
  transform: { operation: name => name.replace(/ApiTauri(?:Extension|Archive|Model|Ui|Notification|Worktree|Bridge|Remote)/, '') },
  patch: { operations: { post: 'postWorktree', delete: 'deleteWorktree' } },
  servers: [...plugins.map(plugin => ({
    input: `${root}packages/builtin-plugin-${plugin}/src/host/server/index.ts`,
    output: {
      main: `${root}packages/builtin-plugin-${plugin}/src/client/apis/index.ts`,
      type: `${root}packages/builtin-plugin-${plugin}/src/client/apis/index.type.ts`,
    },
  })), {
    input: `${root}packages/builtin-plugin-remote/src/host/server/index.ts`,
    meta: { import: { http: './http' } },
    output: {
      main: `${root}apps/desktop/src/apis/remote.ts`,
      type: `${root}apps/desktop/src/apis/remote.types.ts`,
    },
  }],
})
