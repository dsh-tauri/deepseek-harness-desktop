import type { ClientAdapter } from 'dsh-tauri/client'
import type { PetActionResult, PetListItem, PetStatus, PresetPetItem } from './pet.types'
import { invoke } from 'dsh-tauri/client'
import {
  CMD_CHECK_PET_UPDATES,
  CMD_DELETE_PET,
  CMD_GET_FORCE_XWAYLAND,
  CMD_GET_PET_OVERLAY_SUPPORTED,
  CMD_GET_PET_STATUS,
  CMD_IMPORT_PET,
  CMD_IMPORT_PET_REPOSITORY,
  CMD_LIST_PETS,
  CMD_LIST_PRESET_PETS,
  CMD_OPEN_EXTERNAL_URL,
  CMD_SET_ACTIVE_PET,
  CMD_SET_FORCE_XWAYLAND,
  CMD_SET_PET_ENABLED,
  CMD_SET_PET_SIZE,
  CMD_SET_PET_THROW_ENABLED,
  CMD_UPDATE_PET_REPOSITORY,
  PET_COMMUNITY_URL,
  PET_HATCH_PROMPT,
} from '../constants'
import { store } from '../store'
import { chooseWorkspace, messageOf } from './pet.utils'

/**
 * service/pet.ts — 桌宠领域服务。
 *
 * 两种原型：Query（`load*`，只读数据并更新 store）与 Action（领域动词，响应用户意图
 * 并更新 store）。无模块级可变状态、无副作用生命周期。
 */
async function guard(label: string, action: () => Promise<PetActionResult>): Promise<PetActionResult> {
  try {
    return await action()
  }
  catch (error) {
    console.error(`[dsh-tauri-pet] ${label} failed:`, error)
    return { ok: false, error: messageOf(error) }
  }
}

/** Query：拉取桌宠状态快照；按轮次提交，过期响应不覆盖新状态。 */
export async function loadPetStatus(): Promise<PetStatus | null> {
  const revision = store.pet.beginFetch()
  try {
    const status = await invoke<PetStatus>(CMD_GET_PET_STATUS)
    store.pet.commitFetch(revision, status)
    return status
  }
  catch (error) {
    console.error('[dsh-tauri-pet] load pet status failed:', error)
    return null
  }
}

/**
 * Query：读取当前环境能否让桌宠窗口置顶并定位（issue #649）。
 *
 * 与清单装载分开发起：判定失败只应让提示不出现，不该把设置页整体打成错误态。
 * 失败返回 `null` 并保留 store 中的旧值，重试交给下一次进入设置页。
 */
export async function loadPetOverlaySupported(): Promise<boolean | null> {
  try {
    const supported = await invoke<boolean>(CMD_GET_PET_OVERLAY_SUPPORTED)
    store.pet.setOverlaySupported(supported)
    return supported
  }
  catch (error) {
    console.error('[dsh-tauri-pet] load pet overlay support failed:', error)
    return null
  }
}

/**
 * Query：读取「强制 XWayland」开关的持久值（issue #649）。
 *
 * 与 `loadPetOverlaySupported` 同样的失败语义：返回 `null` 并保留 store 中的旧值，
 * 读不到只让开关不出现，不把设置页整体打成错误态。
 */
export async function loadForceXwayland(): Promise<boolean | null> {
  try {
    const enabled = await invoke<boolean>(CMD_GET_FORCE_XWAYLAND)
    store.pet.setForceXwayland(enabled)
    return enabled
  }
  catch (error) {
    console.error('[dsh-tauri-pet] load force xwayland failed:', error)
    return null
  }
}

/** Query：装载预设 / Chat / Codex 三份清单，并顺带刷新共享状态快照。 */
export async function loadPetCatalog(): Promise<PetActionResult> {
  const revision = store.pet.beginFetch()
  return guard('load pet catalog', async () => {
    const [status, chat, codex, presets] = await Promise.all([
      invoke<PetStatus>(CMD_GET_PET_STATUS),
      invoke<PetListItem[]>(CMD_LIST_PETS, { source: 'chat' }),
      invoke<PetListItem[]>(CMD_LIST_PETS, { source: 'codex' }),
      invoke<PresetPetItem[]>(CMD_LIST_PRESET_PETS),
    ])
    store.pet.setCatalog({ presets, chat, codex })
    store.pet.commitFetch(revision, status)
    return { ok: true }
  })
}

/** Action：选中宠物（状态以桌面端返回的权威快照为准）。 */
export async function choosePet(input: { id: string }): Promise<PetActionResult> {
  return guard('choose pet', async () => {
    store.pet.setStatus(await invoke<PetStatus>(CMD_SET_ACTIVE_PET, { id: input.id }))
    return { ok: true }
  })
}

/** Action：启用预设宠物——选中它，并确保桌宠被唤醒。 */
export async function enablePet(input: { id: string }): Promise<PetActionResult> {
  return guard('enable pet', async () => {
    let status = await invoke<PetStatus>(CMD_SET_ACTIVE_PET, { id: input.id })
    if (!status.enabled)
      status = await invoke<PetStatus>(CMD_SET_PET_ENABLED, { enabled: true })
    store.pet.setStatus(status)
    return { ok: true }
  })
}

/**
 * Action：取消选择；仍在启用时一并关闭桌宠（无内容可渲染，不留空窗口）。
 *
 * 先关闭再清空：若第二步失败，最坏情况也只是保留选择但窗口已销毁。任一步失败都从
 * 后端重拉状态，避免界面与持久层不一致。
 */
export async function clearPetSelection(): Promise<PetActionResult> {
  const status = store.pet.$state.status
  try {
    if (status?.enabled)
      store.pet.setStatus(await invoke<PetStatus>(CMD_SET_PET_ENABLED, { enabled: false }))
    store.pet.setStatus(await invoke<PetStatus>(CMD_SET_ACTIVE_PET, { id: '' }))
    return { ok: true }
  }
  catch (error) {
    console.error('[dsh-tauri-pet] clear pet selection failed:', error)
    await loadPetStatus()
    return { ok: false, error: messageOf(error) }
  }
}

/** Action：启用/关闭桌宠（纯持久开关，关闭后重启不再自动拉起）。 */
export async function togglePet(input: { enabled: boolean }): Promise<PetActionResult> {
  return guard('toggle pet', async () => {
    store.pet.setStatus(await invoke<PetStatus>(CMD_SET_PET_ENABLED, { enabled: input.enabled }))
    return { ok: true }
  })
}

/**
 * Action：切换「强制 XWayland」开关。
 *
 * 只落盘，不改变本次进程的任何行为：`GDK_BACKEND` 在 GTK 初始化时已被读走，
 * 生效要等下次启动，调用方据此提示用户重启。
 */
export async function toggleForceXwayland(input: { enabled: boolean }): Promise<PetActionResult> {
  return guard('toggle force xwayland', async () => {
    store.pet.setForceXwayland(await invoke<boolean>(CMD_SET_FORCE_XWAYLAND, { enabled: input.enabled }))
    return { ok: true }
  })
}

/** Action：调整桌宠窗口大小。 */
export async function resizePet(input: { size: number }): Promise<PetActionResult> {
  return guard('resize pet', async () => {
    store.pet.setStatus(await invoke<PetStatus>(CMD_SET_PET_SIZE, { size: input.size }))
    return { ok: true }
  })
}

/**
 * Action：开关抛射能力（拖拽甩出后飞行、撞屏幕边缘回弹）。
 *
 * 与 `togglePet` 同形：命令回吐权威状态，前端不做乐观本地副本；抛射开关经
 * `pet://status` 广播给桌宠窗口，立即生效。
 */
export async function togglePetThrow(input: { enabled: boolean }): Promise<PetActionResult> {
  return guard('toggle pet throw', async () => {
    store.pet.setStatus(await invoke<PetStatus>(CMD_SET_PET_THROW_ENABLED, { enabled: input.enabled }))
    return { ok: true }
  })
}

export async function loadPetUpdates(): Promise<PetActionResult> {
  return guard('check pet updates', async () => {
    const presets = store.pet.$state.presetPets
    const ids = await invoke<string[]>(CMD_CHECK_PET_UPDATES)
    if (presets === store.pet.$state.presetPets)
      store.pet.setPetUpdates(ids)
    return { ok: true }
  })
}

export async function updatePetRepository(input: { id: string }): Promise<PetActionResult> {
  return guard('update pet repository', async () => {
    const item = await invoke<PresetPetItem>(CMD_UPDATE_PET_REPOSITORY, { id: input.id })
    store.pet.replacePresetPet({ ...item, remote: true })
    return { ok: true }
  })
}

export async function importPetRepository(input: { repository: string }): Promise<PetActionResult> {
  const match = /^(?:https:\/\/github\.com\/)?([a-z\d](?:[a-z\d-]{0,37}[a-z\d])?)\/([\w.-]{1,100})\/?$/i.exec(input.repository.trim())
  if (!match || match[2] === '.' || match[2] === '..')
    return { ok: false, error: 'PET_REPOSITORY_INVALID' }
  return guard('import pet repository', async () => {
    await invoke<PresetPetItem>(CMD_IMPORT_PET_REPOSITORY, { repository: `${match[1]}/${match[2]}` })
    store.pet.setPresetPets(await invoke<PresetPetItem[]>(CMD_LIST_PRESET_PETS))
    return { ok: true }
  })
}

/** Action：导入宠物压缩包（base64），成功后刷新 Codex 清单。 */
export async function importPetArchive(input: { name: string, data: string }): Promise<PetActionResult> {
  return guard('import pet', async () => {
    await invoke<PetListItem>(CMD_IMPORT_PET, { name: input.name, data: input.data })
    store.pet.setCodexPets(await invoke<PetListItem[]>(CMD_LIST_PETS, { source: 'codex' }))
    return { ok: true }
  })
}

/**
 * Action：删除用户导入的宠物（来源限定 id 删目录，预设 id 反注册远端条目）。
 *
 * 先本地摘掉卡片再重装清单：删除已经落定，清单刷新失败不能把这次删除报成失败——
 * 用户会重试一个已经不存在的 id，而卡片还留在列表里。
 */
export async function deletePet(input: { id: string }): Promise<PetActionResult> {
  return guard('delete pet', async () => {
    store.pet.setStatus(await invoke<PetStatus>(CMD_DELETE_PET, { id: input.id }))
    store.pet.removePet(input.id)
    await loadPetCatalog()
    return { ok: true }
  })
}

/**
 * Action：在系统浏览器中打开 Codex 宠物社区站点。
 *
 * 只借桌面端既有的外链命令，不开新窗口、不改任何持久状态。
 */
export async function openCommunityShare(): Promise<PetActionResult> {
  return guard('open community share', async () => {
    await invoke(CMD_OPEN_EXTERNAL_URL, { url: PET_COMMUNITY_URL })
    return { ok: true }
  })
}

/**
 * Action：新建桌宠会话——挑工作区、建会话、装一次性草稿、打开会话并收起设置面板。
 *
 * 工作区目标顺序见 `chooseWorkspace`；官方导航能力缺席时明确失败，不猜核心版本。
 */
export async function createPetSession(input: {
  adapter: ClientAdapter
  close?: () => void
}): Promise<PetActionResult> {
  const { adapter, close } = input
  const workspaceId = chooseWorkspace(adapter)
  const connectWorkspace = adapter.workspaces.connectWorkspace
  const open = adapter.sessions.open
  if (workspaceId === undefined || connectWorkspace === undefined)
    return { ok: false, error: 'PET_WORKSPACE_UNAVAILABLE: no workspace can create a pet session' }
  if (open === undefined)
    return { ok: false, error: 'PET_SESSION_UNAVAILABLE: session opener is unavailable' }

  return guard('create pet session', async () => {
    const sessionId = await connectWorkspace(workspaceId)
    if (typeof sessionId !== 'string' || sessionId.length === 0)
      return { ok: false, error: 'PET_SESSION_UNAVAILABLE: workspace did not return a session id' }
    store.pet.setPrefill(sessionId, PET_HATCH_PROMPT)
    close?.()
    open(sessionId)
    return { ok: true }
  })
}
