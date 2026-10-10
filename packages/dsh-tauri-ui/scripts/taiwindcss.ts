import { Buffer } from 'node:buffer'
import { existsSync, watch } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import process from 'node:process'
import tailwindcss from '@tailwindcss/postcss'
import postcss from 'postcss'

// ==========================================
// 路径与常量配置
// ==========================================
const PACKAGE_ROOT = resolve(import.meta.dirname, '..')
const REPO_ROOT = resolve(PACKAGE_ROOT, '../..')
const PACKAGES_ROOT = join(REPO_ROOT, 'packages')
const STYLES_DIR = join(PACKAGE_ROOT, 'src', 'client', 'styles')
const INPUT_FILE = join(STYLES_DIR, 'index.css')
const OUTPUT_FILE = join(STYLES_DIR, 'index.ts')

/** 决定产物的配置：plugins 配置是入口且主题自带（不继承 tailwind.config.js），根配置改动只需触发重建。 */
const CONFIG_FILES = new Set(['tailwind.config.js', 'tailwind.plugins.config.js'])

/** 扫描口径与 tailwind.plugins.config.js 的 content 一致：只认 packages 下各包 src 目录里的源码与样式。 */
const SOURCE_FILE_PATTERN = /[\\/]src[\\/].*\.(?:css|js|jsx|ts|tsx)$/
const DEBOUNCE_MS = 120

/**
 * 只有 `build` 传 `--minify`：它压缩产物后再打包，打完立刻用未压缩产物把文件还原，
 * 因此仓库与 dev 里始终是未压缩产物，发布出去的 dist 里是压缩过的 CSS。
 */
const MINIFY = process.argv.includes('--minify')

// 内存中缓存输出文件内容，避免频繁磁盘读操作
let cachedOutputFileContent: string | null = null

// ==========================================
// 核心编译与渲染逻辑
// ==========================================

/**
 * 把 index.css 编译成插件侧 Tailwind 产物。
 *
 * 产物内嵌进模板字符串并提交进仓库，默认保持未压缩：压缩后整份 CSS 只有一行，任何一处
 * utility 增减都会重写那一行，多个 PR 之间必然整行冲突；未压缩时改动落在具体行上。
 * `--minify` 只给 `build` 用（压缩产物进 dist，打包完再由未压缩的一次生成还原文件）。
 *
 * 空结果必须当成失败：`@config` / `content` 解析不出来时 Tailwind 只往 stderr 打日志、
 * 照常返回空 CSS，直接落盘就会用空样式覆盖上一份产物，而构建仍然「成功」。
 */
async function compile(): Promise<string> {
  const rawCss = await readFile(INPUT_FILE, 'utf8')
  const result = await postcss([tailwindcss(MINIFY ? { optimize: { minify: true } } : {})]).process(rawCss, {
    from: INPUT_FILE,
  })

  const trimmedCss = result.css.trim()
  if (trimmedCss === '') {
    throw new Error('TAILWIND_EMPTY_OUTPUT: 编译结果为空（多为 @config / content 解析失败），保留上一份产物')
  }

  return result.css
}

/**
 * 产物以模板字符串内嵌 CSS，因此必须先转义反斜杠：Tailwind 的选择器转义（`.md\:flex`）
 * 会被模板字面量吃成 `.md:flex`。反引号与 `${` 同理。
 */
function render(css: string): string {
  const body = css
    .trimEnd()
    .replaceAll('\\', '\\\\')
    .replaceAll('`', '\\`')
    .replaceAll('${', '\\${')

  return `import { cssr } from '../utils/cssr'

const TAILWINDCSS_GENERATED = \`
${body}
\`

const tailwindcss = cssr.c([TAILWINDCSS_GENERATED])

export default tailwindcss
`
}

/**
 * 检查并写入产物文件，通过内存缓存 & 异步读写减少不必要的 I/O 消耗
 */
async function write(css: string): Promise<boolean> {
  const source = render(css)

  // 1. 先与内存缓存对比
  if (cachedOutputFileContent === source) {
    return false
  }

  // 2. 若无内存缓存，且文件存在，则读取一次初始化缓存
  if (cachedOutputFileContent === null && existsSync(OUTPUT_FILE)) {
    cachedOutputFileContent = await readFile(OUTPUT_FILE, 'utf8')
    if (cachedOutputFileContent === source) {
      return false
    }
  }

  // 3. 写入文件并更新内存缓存
  await writeFile(OUTPUT_FILE, source, 'utf8')
  cachedOutputFileContent = source
  return true
}

// ==========================================
// 状态控制与并发调度
// ==========================================
let isRunning = false
let isQueued = false

async function regenerate(reason: string): Promise<void> {
  if (isRunning) {
    isQueued = true
    return
  }

  isRunning = true
  const started = Date.now()

  try {
    const css = await compile()
    const changed = await write(css)
    const duration = Date.now() - started
    const sizeKiB = (Buffer.byteLength(css) / 1024).toFixed(1)
    const fileName = basename(OUTPUT_FILE)

    console.log(
      `[tailwindcss] ${reason}: ${changed ? 'generated' : 'unchanged'} ${fileName} (${sizeKiB} KiB, ${duration} ms, ${MINIFY ? 'minified' : 'unminified'})`,
    )
  }
  finally {
    isRunning = false
    if (isQueued) {
      isQueued = false
      await regenerate('queued')
    }
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

let timer: ReturnType<typeof setTimeout> | undefined
let pendingReason = ''

function schedule(reason: string): void {
  pendingReason = reason
  if (timer !== undefined) {
    clearTimeout(timer)
  }

  timer = setTimeout(() => {
    timer = undefined
    const currentReason = pendingReason
    void regenerate(currentReason).catch((error: unknown) => {
      console.error(`[tailwindcss] ${currentReason} failed: ${formatError(error)}`)
    })
  }, DEBOUNCE_MS)
}

function isSourceFile(filename: string): boolean {
  return SOURCE_FILE_PATTERN.test(filename) && resolve(PACKAGES_ROOT, filename) !== OUTPUT_FILE
}

// ==========================================
// 主程序入口
// ==========================================
async function main(): Promise<void> {
  await regenerate('initial')

  if (!process.argv.includes('--watch')) {
    return
  }

  // 监听 packages 目录下的源码变更
  // 生成物自身落在 packages 下，通过 isSourceFile 过滤避免「写文件 -> 触发重建」无限循环
  watch(PACKAGES_ROOT, { recursive: true }, (_event, filename) => {
    if (filename === null || !isSourceFile(filename)) {
      return
    }

    if (!existsSync(resolve(PACKAGES_ROOT, filename))) {
      console.warn(
        `[tailwindcss] removed ${filename}: Tailwind 的扫描清单不会剔除已删除文件，产物要等下次全新生成（重启 dev 或 build）才收缩`,
      )
    }

    schedule(filename)
  })

  // 两份配置按「监听仓库根 + 过滤文件名」而不是逐个 watch 文件：编辑器原子替换配置时，
  // 单文件监听在 Linux/macOS 上仍绑在旧 inode 上，替换后的改动收不到。
  watch(REPO_ROOT, (_event, filename) => {
    if (filename !== null && CONFIG_FILES.has(filename)) {
      schedule(filename)
    }
  })

  console.log(`[tailwindcss] watching packages/*/src and ${CONFIG_FILES.size} tailwind configs`)
}

try {
  await main()
}
catch (error) {
  console.error(`[tailwindcss] ${formatError(error)}`)
  process.exitCode = 1
}
