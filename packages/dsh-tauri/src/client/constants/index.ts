/**
 * client/constants/index.ts — 客户端常量模块（同侧多消费方共享的字面量）。
 *
 * 归属规则见 `docs/specs/agents.plugins.md` 的《通用协议：常量归属》：只被一个文件使用的
 * 常量定义在消费方文件里（模块级 const、不导出）——协议字面量、effect 标签、样式 id
 * 都不因“位置特殊”豁免。本文件只放**同侧两个及以上**文件消费的常量。
 */

/** 插件 id（npm 包名）：客户端入口的自报名 + 插件错误上报的注册表主键。 */
export const PLUGIN_ID = 'dsh-tauri'

/**
 * 官方「新建会话」按钮：适配层的 DOM 退级目标，同时是侧边栏 UI 微调的居中目标。
 *
 * 与官方 aria-label 逐字一致（中英双语各一条）；绝不用生成的 CSS module 哈希。
 */
export const NEW_SESSION_SELECTOR = 'button[aria-label="新建会话"],button[aria-label="New session"]'
