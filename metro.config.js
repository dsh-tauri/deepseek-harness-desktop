import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
// 根 package.json 是 `"type": "module"`，Node 的 ESM 解析不做扩展名补齐，
// 而 `expo` 包没有 `exports` 字段 ⇒ 必须写完整的 `expo/metro-config.js`（CJS 入口，命名导出经 interop 可用）。
import { getDefaultConfig } from 'expo/metro-config.js'
import { withUniwindConfig } from 'uniwind/metro'

// 本仓库根 package.json 是 `"type": "module"`，metro-config 会用 import() 加载本文件。
// 注意用 path.dirname(fileURLToPath(...)) 取目录：`new URL('.', …)` 转出来的路径带结尾分隔符，
// 某些库（uniwind/metro 等）对它做 path.dirname 会落到仓库的上一级。
const rootDir = path.dirname(fileURLToPath(import.meta.url))

const config = withUniwindConfig(getDefaultConfig(rootDir), {
  cssEntryFile: './src-native/global.css',
  dtsFile: './src-native/uniwind-types.d.ts',
})

const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// 仓库根的 `tsconfig.json` 是桌面端的配置，其中 `"@/*": ["src/*"]`；而 Expo CLI 的 tsconfig paths
// 解析器（@expo/cli …/createTypescriptResolver.js）读的正是工程根的 tsconfig.json ⇒ native 代码里的
// `@/x` 会被错解析到桌面端 `src/x`（`@/config/client` 两侧同名时更会静默串味，`@/hooks/use-hosts-health`
// 则直接解析失败）。这里在用户解析器里先行短路，把 `@/x` 钉到 `src-native/x`（与 tsconfig.native.json 的
// paths 一致）；用户解析器先于 Expo 内置解析器执行，未命中的模块仍按原链条继续解析。
const upstreamResolveRequest = config.resolver.resolveRequest
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolveRequest = upstreamResolveRequest ?? context.resolveRequest
  if (moduleName === '@' || moduleName.startsWith('@/')) {
    return resolveRequest(context, path.join(rootDir, 'src-native', moduleName.slice(2)), platform)
  }
  return resolveRequest(context, moduleName, platform)
}

// 仓库根同时存在体积很大的非移动端目录（内核源码、worktree、构建产物）；
// 只屏蔽工程根下的同名目录，避免误伤 node_modules 内的 dist。
const blockedRootDirs = ['.git', '.temp', '.tmp', '.worktrees', 'source', 'src-tauri', 'dist']
config.resolver.blockList = [
  ...[config.resolver.blockList].flat().filter(Boolean),
  ...blockedRootDirs.map(dir => new RegExp(`^${escapeRegExp(path.join(rootDir, dir))}[\\\\/]`)),
]

if (process.platform === 'win32') {
  // 本机 Windows 上并行 worker 太多会拖慢/耗尽内存；缓存目录沿用 Metro 默认（os.tmpdir）。
  config.maxWorkers = 2
}

export default config
