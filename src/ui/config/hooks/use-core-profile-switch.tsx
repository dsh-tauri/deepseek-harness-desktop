import type { HarnessCore, Profile, RuntimeInfo } from '@/types'
import type { CoreUpgradeChoice, CoreUpgradeProfileDialogProps } from '@/ui/dialog/core-upgrade-profile'
import { useOverlay } from '@overlastic/react'
import { useQueryClient } from '@tanstack/react-query'
import { invoke } from '@tauri-apps/api/core'
import { useTranslation } from 'react-i18next'
import { queryKeys } from '@/config/query-keys'
import { CoreUpgradeProfileDialog } from '@/ui/dialog/core-upgrade-profile'
import { coreProfileName, isCoreUpgrade } from '@/utils/core-version'
import { normalizeProfileId } from '@/utils/profile-id'
import { toast } from '@/utils/toast'

/** 核心换版前的档案确认结果 */
export interface CoreUpgradeGuard {
  /** 警告弹窗是否已处理切换确认（true 时调用方不必再弹普通切换确认） */
  handled: boolean
  /** 回滚到切换前的档案；未切换过时为 undefined */
  rollback?: () => Promise<void>
}

/**
 * 切换/更新核心前的「版本不配套 → 请切换档案」守卫，三个入口共用：
 * 核心面板切换、更新提示 toast（桌面外壳）、调试页「存在新版本」。
 *
 * 核心与档案配套：主/次/修订号变化（升级或降级，issue #748）前，先让用户换成与目标版本同名的
 * 版本档案（缺失则新建）。降级沿用较新档案时，旧核心找不到档案里的包，Harness 无法启动；
 * 升级沿用旧档案则会把不配套的包留在原档案里。同一 x.y.z 的预发布互换不弹窗。
 *
 * 版本比对必须走本地数据：核心面板直接把列表里已加载的「在用核心」版本传进来；
 * 未传时退回只用本地信息的 `get_runtime_info`——绝不能为比对去拉 `get_cores`
 * （它要联网取 GitHub releases，用户点一下要白等数秒）。
 */
export function useCoreProfileSwitch() {
  const [holder, openDialog] = useOverlay<CoreUpgradeProfileDialogProps, CoreUpgradeChoice>(CoreUpgradeProfileDialog, { type: 'holder' })
  const queryClient = useQueryClient()
  const { t } = useTranslation()

  /**
   * 在用核心的版本串（本地读取，不做联网比对）：优先现成的核心列表缓存，
   * 缺失时退回 `get_runtime_info`（本地读 store/清单）。
   */
  async function localActiveVersion(): Promise<string> {
    const cached = queryClient.getQueryData<HarnessCore[]>(queryKeys.cores)
    const cachedActive = cached?.find(c => c.active)
    if (cachedActive)
      return cachedActive.version || cachedActive.tag
    const info = await queryClient.fetchQuery({
      queryKey: queryKeys.info,
      queryFn: () => invoke<RuntimeInfo>('get_runtime_info'),
    })
    return info.dsh_version ?? ''
  }

  /**
   * 目标版本与在用核心的主/次/修订号不同（升级或降级）时弹警告并按用户选择处理档案。
   *
   * `fromVersion` 由调用方从本地已有数据传入（核心面板传列表里的在用核心版本）；
   * 省略时退回本地读取。
   *
   * 返回 null = 中止本次切换（用户取消，或档案切换失败——失败提示由本 hook 发出）。
   */
  async function guardCoreUpgrade(toVersion: string, fromVersion?: string): Promise<CoreUpgradeGuard | null> {
    const from = fromVersion ?? await localActiveVersion()
    // isCoreUpgrade 仍只表示「目标更高」。两个方向一起看，降级才会同样隔离档案。
    if (!isCoreUpgrade(from, toVersion) && !isCoreUpgrade(toVersion, from))
      return { handled: false }

    let choice: CoreUpgradeChoice
    try {
      choice = await openDialog({
        fromVersion: from,
        toVersion,
        defaultName: coreProfileName(toVersion),
      })
    }
    catch {
      return null
    }
    // 明确无视风险时不改档案。沿用当前档案仍可能与目标核心不兼容（issue #748）。
    if (choice.mode === 'ignore')
      return { handled: true }

    try {
      const profiles = await queryClient.fetchQuery({
        queryKey: queryKeys.profiles,
        queryFn: () => invoke<Profile[]>('get_profiles'),
      })
      const previousId = profiles.find(p => p.active)?.id ?? ''
      const id = normalizeProfileId(choice.name)
      const existing = profiles.find(p => p.id === id)
      let switchedId = id
      if (existing) {
        if (!existing.active)
          await invoke<Profile>('set_active_profile', { id })
      }
      else {
        const created = await invoke<Profile>('create_profile', { name: choice.name })
        switchedId = created.id
        await invoke<Profile>('set_active_profile', { id: created.id })
      }
      void queryClient.invalidateQueries({ queryKey: queryKeys.profiles })
      return {
        handled: true,
        rollback: async () => {
          if (!previousId || previousId === switchedId)
            return
          try {
            await invoke<Profile>('set_active_profile', { id: previousId })
          }
          catch (err) {
            console.error('[CoreProfileSwitch] restore active profile failed:', err)
          }
          finally {
            void queryClient.invalidateQueries({ queryKey: queryKeys.profiles })
          }
        },
      }
    }
    catch (err) {
      console.error('[CoreProfileSwitch] switch version profile failed:', err)
      toast(t('core.breaking_profile_failed'), {})
      return null
    }
  }

  return { holder, guardCoreUpgrade }
}
