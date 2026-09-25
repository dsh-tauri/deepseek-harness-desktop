import { Buffer } from 'node:buffer'
import { existsSync, readFileSync, watch, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'
import tailwindcss from '@tailwindcss/postcss'
import postcss from 'postcss'

const PLUGIN_ID = 'dsh-tauri-taiwindcss'
const REPO_ROOT = resolve(import.meta.dirname, '..')
const PACKAGES_ROOT = join(REPO_ROOT, 'packages')
const STYLES_DIR = join(PACKAGES_ROOT, PLUGIN_ID, 'src', 'client', 'styles')
const INPUT_FILE = join(STYLES_DIR, 'index.css')
const OUTPUT_FILE = join(STYLES_DIR, 'taiwindcss.ts')
/** 决定产物的配置：plugins 配置是入口，主题与色板继承 tailwind.config.js。 */
const CONFIG_FILES = ['tailwind.config.js', 'tailwind.plugins.config.js']
/** 扫描口径与 tailwind.plugins.config.js 的 content 一致：只认 packages 下各包 src 目录里的源码与样式。 */
const SOURCE_FILE = /[\\/]src[\\/].*\.(?:css|js|jsx|ts|tsx)$/
const DEBOUNCE_MS = 120

/**
 * 把 index.css 编译成插件侧 Tailwind 产物。
 *
 * 空结果必须当成失败：`@config` / `content` 解析不出来时 Tailwind 只往 stderr 打日志、
 * 照常返回空 CSS，直接落盘就会用空样式覆盖上一份产物，而构建仍然「成功」。
 */
async function compile(): Promise<string> {
  const result = await postcss([tailwindcss()]).process(readFileSync(INPUT_FILE, 'utf8'), { from: INPUT_FILE })
  if (result.css.trim() === '') {
    throw new Error('TAILWIND_EMPTY_OUTPUT: 编译结果为空（多为 @config / content 解析失败），保留上一份产物')
  }
  return result.css
}

/**
 * 产物以模板字符串内嵌 CSS，因此必须先转义反斜杠：Tailwind 的选择器转义（`.md\:flex`）
 * 会被模板字面量吃成 `.md:flex`。反引号与 `${` 同理。
 */
function render(css: string): string {
  const body = css.trimEnd().replaceAll('\\', '\\\\').replaceAll('`', '\\`').replaceAll('${', '\\${')
  return `import { cssr } from 'dsh-tauri-ui/client'

const TAIWINDCSS_GENERATED = \`
${body}
\`

const taiwindcss = cssr.c([TAIWINDCSS_GENERATED])

export default taiwindcss
`
}

function write(css: string): boolean {
  const source = render(css)
  if (existsSync(OUTPUT_FILE) && readFileSync(OUTPUT_FILE, 'utf8') === source) {
    return false
  }
  writeFileSync(OUTPUT_FILE, source)
  return true
}

let running = false
let queued = false

async function regenerate(reason: string): Promise<void> {
  if (running) {
    queued = true
    return
  }
  running = true
  const started = Date.now()
  try {
    const css = await compile()
    const changed = write(css)
    console.log(
      `[build:taiwindcss] ${reason}: ${changed ? 'generated' : 'unchanged'} taiwindcss.ts (${(Buffer.byteLength(css) / 1024).toFixed(1)} KiB, ${Date.now() - started} ms)`,
    )
  }
  finally {
    running = false
    if (queued) {
      queued = false
      await regenerate('queued')
    }
  }
}

function report(error: unknown): string {
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
    const current = pendingReason
    void regenerate(current).catch((error: unknown) => {
      console.error(`[build:taiwindcss] ${current} failed: ${report(error)}`)
    })
  }, DEBOUNCE_MS)
}

function isSourceFile(filename: string): boolean {
  return SOURCE_FILE.test(filename) && resolve(PACKAGES_ROOT, filename) !== OUTPUT_FILE
}

async function main(): Promise<void> {
  await regenerate('initial')
  if (!process.argv.includes('--watch')) {
    return
  }
  // 生成物自己也落在 packages 下，必须挡掉，否则「写文件 → 触发重建」自激。
  watch(PACKAGES_ROOT, { recursive: true }, (_event, filename) => {
    if (filename === null || !isSourceFile(filename)) {
      return
    }
    if (!existsSync(resolve(PACKAGES_ROOT, filename))) {
      console.warn(
        `[build:taiwindcss] removed ${filename}: Tailwind 的扫描清单不会剔除已删除文件，产物要等下次全新生成（重启 dev 或 build）才收缩`,
      )
    }
    schedule(filename)
  })
  // 两份配置按「监听仓库根 + 过滤文件名」而不是逐个 watch 文件：编辑器原子替换配置时，
  // 单文件监听在 Linux/macOS 上仍绑在旧 inode 上，替换后的改动收不到。
  watch(REPO_ROOT, (_event, filename) => {
    if (filename !== null && CONFIG_FILES.includes(filename)) {
      schedule(filename)
    }
  })
  console.log(`[build:taiwindcss] watching packages/*/src and ${CONFIG_FILES.length} tailwind configs`)
}

try {
  await main()
}
catch (error) {
  console.error(`[build:taiwindcss] ${report(error)}`)
  process.exitCode = 1
}
