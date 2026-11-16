import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { defineConfig } from '@genapi/core'
import pipeline from '@genapi/pipeline'
import { ofetch } from '@genapi/presets'
import { original } from 'dsh-h3/genapi'
import { ESLint } from 'eslint'

const root = '../../'
const eslint = new ESLint({ cwd: fileURLToPath(new URL(root, import.meta.url)), fix: true })
const plugins = ['extension', 'archive', 'model', 'ui', 'notification', 'remote']
const remoteEndpointManifest = `${root}packages/builtin-plugin-remote/src/shared/remote-endpoints.json`

function remoteEndpointsOf(path: string | undefined, code: string): string[] | undefined {
  const normalized = path?.replaceAll('\\', '/') ?? ''
  if (!normalized.endsWith('packages/builtin-plugin-remote/src/client/apis/index.ts')
    && !normalized.endsWith('apps/desktop/src/apis/remote.ts')) {
    return undefined
  }
  const endpoints = [...code.matchAll(/'(\/api\/tauri\/remote\/[^']+)', \{ method: '([a-z]+)'/gu)]
    .map(([, path, method]) => `${method?.toUpperCase()} ${path}`)
  if (endpoints.length === 0)
    throw new Error(`no remote endpoints generated for ${normalized}`)
  return endpoints
}

function withOptionalQueryParams(code: string): string {
  return code.replaceAll(
    '{ method: \'get\', params, ...options }',
    '{ method: \'get\', ...params === undefined ? {} : { params }, ...options }',
  )
}

export default defineConfig({
  preset: pipeline((options) => {
    const config = ofetch.ts.config(options)
    const fetchOptions = config.graphs.scopes.main.imports.find(item => item.names?.includes('FetchOptions'))!
    fetchOptions.value = options.meta!.import!.http!
    fetchOptions.type = true
    return config
  }, original, ofetch.ts.parser, ofetch.ts.compiler, ofetch.ts.generate, async (config) => {
    let remoteEndpoints: string[] | undefined
    for (const output of config.outputs) {
      const [result] = await eslint.lintText(output.code ?? '', { filePath: output.path })
      if (result.errorCount)
        throw new Error(JSON.stringify(result.messages))
      output.code = result.output ?? output.code
      const endpoints = remoteEndpointsOf(output.path, output.code ?? '')
      if (endpoints === undefined)
        continue
      output.code = withOptionalQueryParams(output.code ?? '')
      const normalized = [...endpoints].sort()
      if (remoteEndpoints !== undefined && JSON.stringify(normalized) !== JSON.stringify(remoteEndpoints))
        throw new Error('remote plugin and desktop clients generated different endpoints')
      remoteEndpoints = normalized
    }
    if (remoteEndpoints !== undefined)
      await writeFile(remoteEndpointManifest, `${JSON.stringify(remoteEndpoints, null, 2)}\n`)
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
