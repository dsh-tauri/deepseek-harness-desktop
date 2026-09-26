import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'

/** tsdown 单条构建配置（宽松面；运行时由 tsdown 校验）。 */
type TsdownOptions = Record<string, unknown> & { noExternal?: Array<string | RegExp> }

/** 是否处于 watch/dev 模式（dev:plugins → `tsdown --watch` 常驻）：跳过 minify 加速热重建。 */
const isWatchMode = process.argv.includes('--watch') || process.argv.includes('-w')

/** defineDshConfig 的入参（client 可扩展 noExternal）。 */
export interface DshConfigOptions {
  /** 宿主 entry 的 tsdown 选项（覆盖 common）。 */
  server?: TsdownOptions
  /** client entry 的 tsdown 选项（覆盖 common；noExternal 并入默认内联表）；`false` 表示纯宿主插件。 */
  client?: TsdownOptions | false
  /** 是否对 server entry 跑 publint（默认 true）。 */
  publint?: boolean
}

function clientBundleRegistration() {
  const packageName = process.env.npm_package_name
  const pkg = packageName
    ? { name: packageName }
    : JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { name: string }
  const id = JSON.stringify(pkg.name)
  // Only the JS bundle is a runtime script wrapped in the ModuleLoader factory.
  // Declaration files must stay real ES modules (top-level import/export) —
  // wrapping them breaks types ("file is not a module") — so apply the wrapper
  // exclusively to JS outputs via the `{ js }` addon form.
  return {
    banner: {
      js: `window.__ModuleLoader__.load({id:${id},factory:(require)=>{const loaderRequire=require;const resolve=(specifier)=>specifier.endsWith('/client')?specifier.slice(0,-7):specifier;require=(specifier)=>loaderRequire(resolve(specifier));var module={exports:{}};var exports=module.exports;`,
    },
    footer: {
      js: 'return module.exports;}});',
    },
  }
}

export const dshExternal: Array<string | RegExp> = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  'dsh-tauri/client',
  'dsh-tauri-ui/client',
  /^@deepseek-ai\//,
]

/**
 * 需要内联进 client bundle 的依赖（UnJS 工具库 + date-fns + lodash-es + css-render 系列）。
 *
 * client bundle 在 DSH Web ModuleLoader（dsh-client-modules）的 factory 里运行，
 * 其模块表只认识平台种子词（react / @deepseek-ai/*）与已加载的链接模块
 * （dsh-tauri/client）。tsdown 默认把 package.json 的 `dependencies` 当 external，
 * 若这些包在 client 代码里被直接 import，产物会发出 loader 的
 * `require('hookable')` 之类调用——模块表查不到就报
 * "missed the module table"（build-time externals drift）。
 * 因此 client entry 必须把它们内联；host entry 保持 external（Node 运行时按
 * 插件 dependencies 解析）。子路径（unstorage/drivers/*）一并覆盖。
 * date-fns 仅作为构建期 devDependency，并按实际使用导出 tree-shake 后内联；
 * lodash-es 同理（无 exports 映射，子路径 `lodash-es/<fn>.js` 一并内联）。
 *
 * css-render / @css-render/plugin-bem 与 @gravity-ui/icons 同类：纯 client UI 库，
 * 只被插件 client 样式代码消耗，声明为 dependencies 时会被 tsdown 默认 external，
 * 使 loader 模块表查不到；凡在 client 里直接 import 必须内联。统一经
 * dsh-tauri-ui/client 提供 cssr 实例的插件不应再单独内联（它们是共享实例的
 * 消费者），只有真正直接 import 这两个包的 client bundle 才需要内联。
 */
const dshClientInline: Array<string | RegExp> = [
  /^(unstorage|hookable|ofetch|pathe|date-fns|lodash-es)([/-].*)?$/,
  /^@gravity-ui\/icons([/-].*)?$/,
  /^css-render([/-].*)?$/,
  /^@css-render\/plugin-bem([/-].*)?$/,
]

export function defineDshConfig(options: DshConfigOptions = {}) {
  const { noExternal: clientNoExternal, ...clientOptions } = options.client === false ? {} : options.client ?? {}
  const common: TsdownOptions = {
    outDir: 'dist',
    format: 'esm',
    outExtensions: () => ({ js: '.js' }),
    publint: options.publint ?? true,
    external: dshExternal,
  }

  const server: TsdownOptions = {
    ...common,
    ...options.server,
    entry: { index: 'src/index.ts' },
    dts: true,
    sourcemap: false,
    clean: true,
  }
  // 纯宿主插件没有浏览器半区：`client: false` 时只产出宿主 entry，不写 `src/client/`。
  if (options.client === false) {
    return [server]
  }

  return [
    server,
    {
      ...common,
      entry: { client: 'src/client/index.ts' },
      // Client bundles are classic scripts consumed by dsh-client-modules.
      // CJS output is required so its exports remain inside the loader factory.
      format: 'cjs',
      // UnJS 四库内联（模块表不认识的依赖不能留 require，见 dshClientInline 注释）。
      noExternal: [...dshClientInline, ...(clientNoExternal ?? [])],
      // CJS must not use `.js` in a `"type": "module"` package — publint would
      // flag the ESM/CJS mismatch. Emit `.cjs` (declarations pair as `.d.cts`).
      outExtensions: () => ({ js: '.cjs' }),
      define: { 'process.env.NODE_ENV': JSON.stringify('production') },
      ...clientBundleRegistration(),
      // The client entry is deliberately a classic CJS script wrapped by ModuleLoader;
      // publint's ESM/CJS default-export heuristic is inapplicable.
      publint: false,
      dts: false,
      sourcemap: true,
      minify: !isWatchMode,
      clean: false,
      ...clientOptions,
    },
  ]
}

export { defineConfig } from 'tsdown'
