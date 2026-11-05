/**
 * 生成壳层注入用的样式：
 * 1. 用独立配置构建 `src/styles/main.css`（Tailwind + HeroUI）为单份 CSS；
 * 2. 把文档级选择器重写为 Shadow DOM 作用域（`:root` → `:host` 等）；
 * 3. 固化为 `src-tauri/src/desktop/shell.css`，供 Rust `include_str!` 内联。
 *
 * 之所以把重写放在这里：重写逻辑只有一份（`src/shell/shadow-css.ts`，带单测），
 * Rust 侧只负责原样内联，避免两种语言维护同一套选择器规则。
 */
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { rewriteForShadowRoot } from '../src/shell/shadow-css'
import shellConfig from '../vite.shell.config'

const root = fileURLToPath(new URL('..', import.meta.url))
const builtCss = fileURLToPath(new URL('../dist-shell/shell.css', import.meta.url))
const target = fileURLToPath(new URL('../src-tauri/src/desktop/shell.css', import.meta.url))

async function main(): Promise<void> {
  const config = typeof shellConfig === 'function' ? await shellConfig({ command: 'build', mode: 'production' }) : shellConfig
  await build({ ...config, configFile: false, logLevel: 'warn' })

  const raw = readFileSync(builtCss, 'utf8')
  const scoped = rewriteForShadowRoot(raw)
  const banner = '/* 由 apps/desktop/scripts/build-shell-css.ts 生成，请勿手改。 */\n'
  writeFileSync(target, banner + scoped)
  console.log(`shell.css: ${raw.length} -> ${scoped.length} bytes -> ${target}`)
  console.log(`size on disk: ${statSync(target).size} bytes`)
}

void main()
