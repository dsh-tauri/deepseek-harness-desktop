import type { PetListItem, PetStatus, PresetPetItem } from '../../service/pet.types'
import { defineStore } from 'dsh-tauri/client'

/**
 * store/modules/pet.ts — 桌宠状态与清单缓存（valtio-define 域存储）。
 *
 * 侧栏入口图标是原生 DOM 补丁按钮（非 React 组件），设置页是 settings.section 的
 * React 组件，两者互不感知，因此共享这一份缓存：图标经 `$subscribe` 订阅切换绿点，
 * 设置页经 `useStore(store.pet)` 读写状态。
 */
export const pet = defineStore({
  state: () => ({
    /** 最近一次从桌面端读回的桌宠状态缓存。 */
    status: null as PetStatus | null,
    /** 状态拉取轮次：只有最新一轮允许写回首屏快照。 */
    fetchRevision: 0,
    /** 清单是否装载过（设置页首屏加载态判定）。 */
    catalogLoaded: false,
    presetPets: [] as PresetPetItem[],
    petUpdates: [] as string[],
    chatPets: [] as PetListItem[],
    codexPets: [] as PetListItem[],
    /** 待注入的新会话草稿（sessionId → 文本）。 */
    prefills: {} as Record<string, string>,
    /** 当前环境能否让桌宠窗口置顶并定位；`null` 为尚未读取（issue #649）。 */
    overlaySupported: null as boolean | null,
    /** 「强制 XWayland」开关的持久值；`null` 为尚未读取（issue #649）。 */
    forceXwayland: null as boolean | null,
  }),
  actions: {
    /** 开始一次状态拉取，返回其轮次。 */
    beginFetch(): number {
      this.fetchRevision += 1
      return this.fetchRevision
    },
    /** 提交某轮状态拉取：非最新轮次直接丢弃（并发时旧响应不得覆盖新状态）。 */
    commitFetch(revision: number, status: PetStatus): boolean {
      if (revision !== this.fetchRevision)
        return false
      this.status = status
      return true
    },
    /** 覆写状态缓存并推进轮次（使在途的旧拉取失效）。 */
    setStatus(status: PetStatus | null): void {
      this.fetchRevision += 1
      this.status = status
    },
    setCatalog(input: { presets: PresetPetItem[], chat: PetListItem[], codex: PetListItem[] }): void {
      this.presetPets = input.presets
      this.chatPets = input.chat
      this.codexPets = input.codex
      this.catalogLoaded = true
    },
    setOverlaySupported(supported: boolean): void {
      this.overlaySupported = supported
    },
    setForceXwayland(enabled: boolean): void {
      this.forceXwayland = enabled
    },
    setPresetPets(list: PresetPetItem[]): void {
      this.presetPets = list
    },
    setPetUpdates(ids: string[]): void {
      this.petUpdates = ids
    },
    replacePresetPet(item: PresetPetItem): void {
      this.presetPets = this.presetPets.map(pet => pet.id === item.id ? item : pet)
      this.petUpdates = this.petUpdates.filter(id => id !== item.id)
    },
    setCodexPets(list: PetListItem[]): void {
      this.codexPets = list
    },
    /** 摘掉已删除的条目；清单刷新失败时卡片不能继续留在列表里。 */
    removePet(id: string): void {
      this.presetPets = this.presetPets.filter(item => item.id !== id)
      this.petUpdates = this.petUpdates.filter(item => item !== id)
      this.chatPets = this.chatPets.filter(item => item.id !== id)
      this.codexPets = this.codexPets.filter(item => item.id !== id)
    },
    setPrefill(sessionId: string, draft: string): void {
      this.prefills[sessionId] = draft
    },
    /** 取出并消费某个会话的草稿（一次性注入）。 */
    takePrefill(sessionId: string): string | undefined {
      const draft = this.prefills[sessionId]
      if (draft === undefined)
        return undefined
      delete this.prefills[sessionId]
      return draft
    },
    clearPrefills(): void {
      this.prefills = {}
    },
  },
})
