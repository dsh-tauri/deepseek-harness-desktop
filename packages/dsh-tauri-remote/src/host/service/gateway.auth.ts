import type { ComponentType } from 'react'
import type { Rolldown } from 'tsdown'
import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Rolldown as bundler } from 'tsdown'

const require = createRequire(import.meta.url)
const buildRequire = createRequire(require.resolve('tsdown'))
const { transform } = buildRequire('lightningcss') as {
  transform: (options: { filename: string, code: Buffer, cssModules: boolean, minify: boolean }) => { code: Buffer, exports: Record<string, { name: string }> }
}

let html: Promise<string> | undefined

export function gatewayAuthHtml(): Promise<string> {
  return html ??= renderGatewayAuthHtml()
}

async function renderGatewayAuthHtml(): Promise<string> {
  const atomsEntry = require.resolve('@deepseek-ai/dsh-client-ui-primitives')
  const atomsRequire = createRequire(atomsEntry)
  const styles: string[] = []
  const bundle = await bundler.rolldown({
    input: 'gateway-auth',
    platform: 'node',
    transform: { define: { window: 'undefined' } },
    treeshake: {
      moduleSideEffects: false,
      propertyReadSideEffects: false,
      manualPureFunctions: ['memo', 'forwardRef', 'createContext', 'createCssVariablesTheme', 'createJavaScriptRegexEngine', 'createMathFlow', 'createSnapshotStore', 'Object.freeze', 'setTimeout'],
    },
    plugins: [{
      name: 'gateway-auth',
      resolveId(id) {
        if (id === 'gateway-auth')
          return '\0gateway-auth'
        if (id === '@deepseek-ai/dsh-client-ui-primitives')
          return atomsEntry
        if (/^[^./\0]/.test(id)) {
          let resolved: string
          try {
            resolved = pathToFileURL(atomsRequire.resolve(id)).href
          }
          catch {
            resolved = id
          }
          return { id: resolved, external: true, moduleSideEffects: false }
        }
      },
      load(id) {
        if (id === '\0gateway-auth')
          return 'export { FishLogo, Input, Button } from \'@deepseek-ai/dsh-client-ui-primitives\''
        if (!id.endsWith('.css'))
          return
        if (!/(?:Button|Input)\.module\.css$/.test(id))
          return { code: 'export default {}', moduleType: 'js', moduleSideEffects: false }
        const result = transform({ filename: id, code: readFileSync(id), cssModules: true, minify: true })
        styles.push(result.code.toString())
        const classes = Object.fromEntries(Object.entries(result.exports).map(([key, value]) => [key, value.name]))
        return { code: `export default ${JSON.stringify(classes)}`, moduleType: 'js', moduleSideEffects: false }
      },
    }],
  })
  let code: string
  try {
    const { output } = await bundle.generate({ format: 'esm', inlineDynamicImports: true })
    code = (output[0] as Rolldown.OutputChunk).code
  }
  finally {
    await bundle.close()
  }
  const { FishLogo, Input, Button } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`) as Record<'FishLogo' | 'Input' | 'Button', ComponentType<Record<string, unknown>>>
  const themeSource = readFileSync(join(dirname(require.resolve('@deepseek-ai/dsh-client-ui-theme')), 'client.js'), 'utf8')
  const theme = ['base', 'design_platform', 'focus'].map((name) => {
    const literal = themeSource.match(new RegExp(`var ${name}_css_default = ("(?:[^"\\\\]|\\\\.)*");`))?.[1]
    if (literal === undefined)
      throw new Error(`Gateway auth theme is missing ${name} CSS`)
    return JSON.parse(literal) as string
  }).join('')
  const dark = [...theme.matchAll(/body\[data-ds-dark-theme\]\{[^}]+\}/g)].map(match => match[0].replace('body[data-ds-dark-theme]', 'body')).join('')
  if (dark === '')
    throw new Error('Gateway auth theme is missing dark tokens')
  const css = `${theme}@media(prefers-color-scheme:dark){${dark}}${styles.join('')}
*{box-sizing:border-box}html{color-scheme:light dark}body{margin:0;min-height:100svh;display:grid;place-items:center;padding:24px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family)}main{width:min(100%,360px);text-align:center}main>svg{color:var(--dsw-alias-state-business-primary)}h1{font-size:24px;line-height:32px;font-weight:600;margin:20px 0 32px}form{display:grid;gap:16px}label{font-size:14px;line-height:22px;text-align:left}form>span{height:44px}input{font:inherit}form>button{height:44px;width:100%}[role=alert]{color:var(--dsw-alias-state-error-primary);font-size:14px;line-height:22px;margin:0 0 16px}`
  const body = renderToStaticMarkup(createElement('main', null, createElement(FishLogo, { size: 64 }), createElement('h1', null, 'DeepSeek Harness'), '__GATEWAY_AUTH_MESSAGE__', createElement('form', { id: 'loginForm', method: 'post' }, createElement('label', { htmlFor: 'code' }, '请输入配对码'), createElement(Input, { id: 'code', name: 'code', type: 'text', autoComplete: 'one-time-code', autoCapitalize: 'characters', spellCheck: false, autoFocus: true, required: true }), createElement(Button, { type: 'submit', variant: 'primary' }, '连接'))))
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DeepSeek Harness</title><style>${css}</style></head><body>${body}</body></html>`
}
