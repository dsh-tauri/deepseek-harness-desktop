// ESLint 扁平配置：基于 @antfu/eslint-config 预设
// 项目为 React + TypeScript + Vite 应用，显式开启 React 支持
// （React 插件依赖 @eslint-react/eslint-plugin 与 eslint-plugin-react-refresh）
import antfu from '@antfu/eslint-config'

export default antfu({
  react: true,
  ignores: [
    'AGENTS.*',
    'docs',
    'archive',
    // 技能目录：脚本与参考文档由技能作者维护（部分经 skills-lock.json 锁定上游哈希），
    // 改动会偏离上游并破坏哈希校验，不参与本仓 lint 规约。
    // 插件包内的 skills/ 随包分发、由技能作者维护，同样按技能资产对待。
    'skills',
    'packages/*/skills',
    // vendored 第三方 crate（含其 README/permissions 产物）：格式由上游决定，
    // 只保留本仓对其的 patch 说明（PATCH.md 由人读，不参与 lint）
    'src-tauri/vendor',
    // genapi 产物：格式由生成器（prettier 默认）决定，不由项目 eslint 规约
    'packages/*/src/client/apis/index.ts',
    'packages/*/src/client/apis/index.type.ts',
    // 同上：genapi 为应用壳生成的 REST 调用层（同目录的 http.ts 是手写实现，仍需 lint）
    'src/apis/remote.ts',
    'src/apis/remote.types.ts',
    // 插件 Tailwind 产物：由 packages/dsh-tauri-ui/scripts/taiwindcss.ts 生成，转义后的选择器与体积
    // 都不适合本仓 lint 规约
    'packages/dsh-tauri-ui/src/client/styles/index.ts',
    // uniwind 产物：由 withUniwindConfig 的 dtsFile 生成（4 空格缩进 + 顶部「勿手改」声明），
    // 每次 metro 启动都会重写，手改会被覆盖，故不参与本仓 lint 规约
    'src-native/uniwind-types.d.ts',
  ],
}, {
  // 插件包是库包而非应用壳：client 侧文件按 host/client 双面设计，
  // 同一文件常同时导出组件与工具函数，react-refresh 的“只导出组件”约束
  // 不适用于库包，故仅在 packages 下关闭该规则。
  files: ['packages/**/*.{ts,tsx,jsx,mts,cts}'],
  rules: {
    'react-refresh/only-export-components': 'off',
  },
})
