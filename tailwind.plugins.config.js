import base from './tailwind.config.js'

/**
 * 插件包（`packages/*`）专用的 Tailwind 配置：复用根配置的主题与 darkMode，
 * 把 content 换成插件包源码。
 *
 * 为什么不能直接复用根配置：Tailwind 的自动内容探测会从 CSS 所在目录一路扫到仓库根，
 * 而 `@config` 的 content 只是**追加**在探测结果之上、覆盖不掉它。两者都会把桌面壳
 * `src/**` 的工具类带进插件产物——产物随壳 UI 改动而变，插件作者也会误用只在那份产物里
 * 存在的类。因此 index.css 用 `source(none)` 关掉自动探测，源清单完全由下面的 content
 * 决定（`source(none)` 之后连显式 `@source` 都会失效，content 是唯一口径）。
 */
/** @type {import("tailwindcss").Config} */
export default {
  ...base,
  content: [
    './packages/*/src/**/*.{js,ts,jsx,tsx}',
    // 生成物自身不能参与扫描：产物里的类名会被再次当成候选，第一次与第二次生成结果不一致
    // （不收敛），提交的 taiwindcss.ts 也就无法稳定复现。
    '!./packages/dsh-tauri-taiwindcss/src/client/styles/taiwindcss.ts',
  ],
}
