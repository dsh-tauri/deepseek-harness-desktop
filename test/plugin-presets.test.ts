import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { stripJsonc } from '../scripts/bundle-metadata.mjs'

const manifest = JSON.parse(stripJsonc(
  readFileSync(new URL('../src-tauri/resources/manifest.jsonc', import.meta.url), 'utf8'),
)) as { plugins: { preset: { id: string }[] } }

const presets = manifest.plugins.preset

describe('community plugin presets', () => {
  it('keeps DSH IM optional without the recommended badge', () => {
    expect(presets.filter(plugin => plugin.id === '@xmanrui/dsh-im')).toMatchObject([
      { spec: '@xmanrui/dsh-im', recommended: false, checked: false },
    ])
  })

  it.each([
    {
      id: '@changfenhuang/dsh-genui',
      spec: '@changfenhuang/dsh-genui',
      name: 'DSH GenUI',
      description: 'GenUI for DeepSeek Harness: interactive UI components rendered inline in assistant replies via the dsh-ui fence — layout, charts, plots, forms, quizzes, mermaid, 3D scenes, and an action event loop back to the model. Ships the fence-teaching host plugin, the browser renderer (client half), and the genui skill.',
      repo: 'https://github.com/omdsh-dev/dsh-genui',
      recommended: false,
      checked: false,
      version: 'latest',
    },
    {
      id: 'dsh-context',
      spec: 'dsh-context',
      name: 'DSH Context',
      description: 'The best DeepSeek Harness plugin for context insight and management, with context dashboard / browser / sidebar and context command, for context statistics, composition, breakdown, evolution details, understanding how the context is made of, and how it evolves. 一站式 DeepSeek Harness 上下文可视化插件，Context 面板及浏览器和侧边栏与 Context 命令，透视上下文组成、演进、压缩、剪枝等事件与动作。',
      repo: 'https://github.com/bowenliang123/dsh-context',
      recommended: false,
      checked: false,
      version: 'latest',
    },
  ])('lists $id once as an optional preset with its GitHub About description', (expected) => {
    expect(presets.filter(plugin => plugin.id === expected.id)).toEqual([expected])
  })
})
