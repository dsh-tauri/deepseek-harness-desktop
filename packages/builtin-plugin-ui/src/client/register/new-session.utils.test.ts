import { describe, expect, it } from 'vitest'
import { isNewSessionLabel } from './new-session.utils'

describe('isNewSessionLabel', () => {
  it('认官方侧边栏「新建会话」按钮的中英两条 aria-label', () => {
    expect(isNewSessionLabel('新建会话'), '官方中文文案').toBe(true)
    expect(isNewSessionLabel('New session'), '官方英文文案').toBe(true)
  })

  it('不认工作区分组行「+」的带名字文案', () => {
    expect(isNewSessionLabel('在“dsh-tauri-desktop”中新建会话'), '官方中文文案（含工作区名）').toBe(false)
    expect(isNewSessionLabel('New session in dsh-tauri-desktop'), '官方英文文案（含工作区名）').toBe(false)
  })

  it('不认英雄区工作区 chip 与其它按钮', () => {
    expect(isNewSessionLabel('选择工作区'), '英雄区 chip 中文').toBe(false)
    expect(isNewSessionLabel('Choose workspace'), '英雄区 chip 英文').toBe(false)
    expect(isNewSessionLabel('收起侧边栏'), '侧边栏折叠按钮').toBe(false)
  })

  it('缺 aria-label 时不命中', () => {
    expect(isNewSessionLabel(null)).toBe(false)
    expect(isNewSessionLabel('')).toBe(false)
  })
})
