import type { CodexPetConfig, PetConfig } from 'dsh-pet-component'
import { useUnmount, useWatch } from '@reause/core'
import { invoke } from '@tauri-apps/api/core'
import { useRef, useState } from 'react'
import { PET_CODEX_ASPECT, PET_DSH_ASPECT } from '../constants'
import { reportPetIssue } from '../utils/log'

/**
 * `resources/manifest.jsonc` 的 `pets.built-in`（Rust `list_preset_pets` 原样返回）。
 *
 * 条目字段即 `dsh-pet-component` 的 `<Pet>` props：预设宠物不再下载/安装到本地，
 * 组件直连条目里的远端素材地址播放。
 */
interface PresetPetItem {
  id: string
  name: string
  desc?: string
  /** 设置页卡片预览图。 */
  image?: string
  /** 渲染器协议；缺省由组件按 config 形状自动判定。 */
  kind?: 'dsh' | 'codex'
  /** 渲染宽度 px（100% 档位）。 */
  size?: number
  /** 配置文件地址（dsh-pet `config.jsonc` / Codex `pet.json`）。 */
  config: string
  /** 素材基地址；`mac` 为 Apple 平台覆盖（HEVC-alpha `.mov`）。 */
  uri: { default: string, mac?: string }
  /** 素材后缀；缺省 `{ default: 'webm', mac: 'mov' }`。 */
  ext?: { default: string, mac?: string }
}

/** 导入的 Codex 宠物资源（Rust `get_pet_asset`，精灵图以 data URL 直接渲染）。 */
interface PetAsset {
  id: string
  spritesheet: string
  sprite_version_number: number
  columns: number
  rows: number
}

/**
 * 渲染一个宠物所需的全部参数 —— `<Pet>` 的渲染 props 加上窗口推导所需的比例。
 *
 * 两种来源走同一条出口：清单里的预设宠物（远端 dsh-pet 视频 / Codex 图集）与
 * 用户导入的 chat/codex 宠物（本地图集，Rust 侧转 data URL）。
 */
export interface PetSource {
  /** 渲染器协议（显式指定，避免组件按 config 形状误判）。 */
  kind: 'dsh' | 'codex'
  config: string | PetConfig
  uri: string | { default: string, mac?: string }
  ext?: { default: string, mac?: string }
  /** 画布比例（高 / 宽），窗口尺寸推导用。 */
  aspect: number
  /** 100% 档位的渲染宽度 px。 */
  width: number
}

/**
 * `usePetSource` 的结果：渲染参数 + 「选中的宠物解析不出来」的原因。
 *
 * `error` 非空时调用方必须给出可见提示：桌宠窗口是透明的，"什么都没有" 与
 * "宠物正在加载" 在观感上完全一样，用户只会认为宠物坏了。
 */
export interface PetSourceState {
  source: PetSource | null
  /** 解析失败的诊断串（id 不存在或命令报错）；`null` = 成功或仍在解析。 */
  error: string | null
}

function presetSource(item: PresetPetItem): PetSource {
  const kind = item.kind ?? 'dsh'
  return {
    kind,
    config: item.config,
    uri: item.uri,
    ext: item.ext,
    aspect: kind === 'codex' ? PET_CODEX_ASPECT : PET_DSH_ASPECT,
    width: item.size ?? 220,
  }
}

function assetSource(asset: PetAsset): PetSource {
  const config: CodexPetConfig = {
    spriteVersionNumber: asset.sprite_version_number === 1 ? 1 : 2,
    columns: asset.columns,
    rows: asset.rows,
  }
  return {
    kind: 'codex',
    config,
    uri: asset.spritesheet,
    aspect: PET_CODEX_ASPECT,
    width: 220,
  }
}

/**
 * 把当前激活宠物 id 解析成渲染参数。
 *
 * - 空 id（未选择宠物）→ `null`；
 * - 来源限定 id（`chat:` / `codex:`，用户导入）→ `get_pet_asset`；
 * - 未限定 id → `list_preset_pets` 里的条目（预设宠物直连远端，无安装态）。
 *
 * 切换宠物时仅接收当前请求的结果。解析失败（导入的宠物已被
 * 删除、清单里没有这个 id、命令报错）不只记日志：把原因交给调用方渲染可见提示 ——
 * 静默留一个空窗口时用户看到的是「宠物加载不出来」，无从判断该去设置页重选。
 */
export function usePetSource(activePet: string): PetSourceState {
  const [resolved, setResolved] = useState<{
    id: string
    value: PetSource | null
    error: string | null
  } | null>(null)

  const requestRef = useRef(0)
  useUnmount(() => {
    requestRef.current++
  })

  useWatch(activePet, (id) => {
    const request = ++requestRef.current
    if (id === '')
      return
    const task = id.includes(':')
      ? invoke<PetAsset>('get_pet_asset', { id }).then(assetSource)
      : invoke<PresetPetItem[]>('list_preset_pets')
          .then(catalog => catalog.find(item => item.id === id))
          .then(item => (item === undefined ? null : presetSource(item)))
    void task
      .then((value) => {
        if (request !== requestRef.current)
          return
        setResolved({
          id,
          value,
          error: value === null ? `PET_NOT_FOUND: ${id}` : null,
        })
      })
      .catch((error) => {
        if (request !== requestRef.current)
          return
        reportPetIssue(`resolve ${id}`, error)
        setResolved({ id, value: null, error: String(error) })
      })
  }, { immediate: true })

  // 尚未拿到当前 id 的结果（加载中）时不报错：避免切换宠物瞬间闪一帧「不可用」。
  const current = resolved !== null && resolved.id === activePet ? resolved : null
  return {
    source: current?.value ?? null,
    error: current?.error ?? null,
  }
}
