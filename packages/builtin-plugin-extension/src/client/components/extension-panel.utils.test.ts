/**
 * client/components/extension-panel.utils.test.ts — 活动标签页必须落在现存标签页上。
 *
 * 守一条事故约束（issue #655）：插件面板重载会让插件页短暂消失，`rows` 里的
 * `plugins` 一并消失。活动页若仍是那个已不存在的 id，面板过滤后一行都不渲染 ——
 * 面板变成空白页，且不会自愈。
 */

import { describe, expect, it } from 'vitest'
import { resolveActiveTab } from './extension-panel.utils'

const WITH_PLUGINS = [{ id: 'plugins' }, { id: 'skills' }, { id: 'mcp' }]
const WITHOUT_PLUGINS = [{ id: 'skills' }, { id: 'mcp' }]

describe('resolveActiveTab', () => {
  it('请求的标签页仍在场：原样保持，不跳回第一页', () => {
    expect(resolveActiveTab(WITH_PLUGINS, 'mcp')).toBe('mcp')
  })

  it('请求的标签页已消失：回落到首个现存标签页，而不是留一个不存在的活动页', () => {
    expect(resolveActiveTab(WITHOUT_PLUGINS, 'plugins')).toBe('skills')
  })

  it('只剩一个标签页时回落到它', () => {
    expect(resolveActiveTab([{ id: 'skills' }], 'plugins')).toBe('skills')
  })

  it('没有任何标签页：返回请求值，不返回 undefined', () => {
    expect(resolveActiveTab([], 'plugins')).toBe('plugins')
  })
})
