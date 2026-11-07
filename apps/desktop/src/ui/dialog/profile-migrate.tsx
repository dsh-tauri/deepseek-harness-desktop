import type { PropsWithOverlays } from '@overlastic/react'
import type { HarnessCore, MigrateReport, MigrationAnalysis, MigrationDataKind, MigrationEntry, MigrationVerdict, Profile } from '@/types'
import { ArrowDown, ArrowRight, ArrowUp } from '@gravity-ui/icons'
import { AlertDialog, Button, Checkbox, Chip, InputGroup, ListBox, Select, Spinner, Tabs } from '@heroui/react'
import { useDisclosure } from '@overlastic/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { invoke } from '@tauri-apps/api/core'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { If } from 'react-if-lite'
import { queryKeys } from '@/config/query-keys'
import { useDshPluginsManager } from '@/hooks/use-plugins-manager'
import { toast } from '@/utils/toast'

/** 判定结果 → Chip 颜色与文案 key */
const VERDICT_CHIPS: Record<MigrationVerdict, { key: string, color: 'default' | 'accent' | 'success' | 'warning' | 'danger' }> = {
  compatible: { key: 'profiles.migrate_verdict_compatible', color: 'default' },
  upgrade: { key: 'profiles.migrate_verdict_upgrade', color: 'success' },
  downgrade: { key: 'profiles.migrate_verdict_downgrade', color: 'warning' },
  unknown: { key: 'profiles.migrate_verdict_unknown', color: 'warning' },
}

/** 档案级数据类别 → 源档案里的文件名 */
const DATA_FILES: Record<MigrationDataKind, string> = {
  patch: 'cordis.patch.yml',
  policy: 'pnpm-workspace.yaml',
  credentials: '.credentials.yaml',
}

/** 数据项的列出顺序：凭据固定最后 */
const DATA_ORDER: MigrationDataKind[] = ['patch', 'policy', 'credentials']

/** 档案级数据类别 → 说明文案 key */
const DATA_LABEL_KEYS: Record<MigrationDataKind, string> = {
  patch: 'profiles.migrate_data_patch',
  policy: 'profiles.migrate_data_policy',
  credentials: 'profiles.migrate_data_credentials',
}

/**
 * 「迁移档案数据」对话框组件
 */
export function ProfileMigrateDialog(props: PropsWithOverlays) {
  const disclosure = useDisclosure({ props })
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const manager = useDshPluginsManager()

  // 1. 数据查询 (Queries)
  const { data: cores } = useQuery({
    queryKey: queryKeys.cores,
    queryFn: () => invoke<HarnessCore[]>('get_cores'),
  })
  const { data: profileList } = useQuery({
    queryKey: queryKeys.profiles,
    queryFn: () => invoke<Profile[]>('get_profiles'),
  })

  // 2. 本地用户选择状态
  const [pickedSourceId, setPickedSourceId] = useState('')
  const [pluginOverrides, setPluginOverrides] = useState<Record<string, boolean>>({})
  const [dataOverrides, setDataOverrides] = useState<Record<string, boolean>>({})

  // 3. 档案迁移分析数据 Query
  const { data: analysis, isLoading, isFetching, error } = useQuery({
    queryKey: queryKeys.profileMigration(pickedSourceId),
    queryFn: () => invoke<MigrationAnalysis>('analyze_profile_migration', { sourceId: pickedSourceId }),
    enabled: Boolean(pickedSourceId),
  })

  // 4. 派生数据提取与 Map 索引构造 (常数级别 O(1) 查找)
  const profiles = profileList ?? []
  const target = profiles.find(profile => profile.active)
  const sources = profiles.filter(profile => !profile.active)

  const activeCore = cores?.find(core => core.active)
  const coreVersion = activeCore ? activeCore.version || activeCore.tag : ''
  const plugins = analysis?.plugins ?? []
  const dataItems = analysis?.data ?? []

  const installedMap = new Map(manager.installed.map(p => [p.id, p.version]))
  const dataItemMap = new Map(dataItems.map(item => [item.kind, item]))
  // 已装列表没到位时不能渲染勾选：`installedMap` 为空会让每个插件都像「未装」而默认勾上
  const analyzing = isLoading || manager.loading
  // 提交还要求分析结果确实到手：后台刷新 / 刷新失败时缓存里的旧选择不能拿来对新来源提交
  const analysisReady = analysis !== undefined && error === null && !isFetching

  /** 有迁移价值：同名插件未装、档案数据未被当前档案完全包含 */
  function pluginMigratable(entry: MigrationEntry): boolean {
    return !installedMap.has(entry.id)
  }

  function dataMigratable(kind: MigrationDataKind): boolean {
    const item = dataItemMap.get(kind)
    return item !== undefined && !item.covered
  }

  /** 勾选状态：不可迁移的一律不选；用户显式切换过的一律以用户为准 */
  function pluginPicked(entry: MigrationEntry): boolean {
    return pluginMigratable(entry) && (pluginOverrides[entry.id] ?? true)
  }

  /** 凭据可能含敏感信息，默认不勾选 */
  function dataPicked(kind: MigrationDataKind): boolean {
    return dataMigratable(kind) && (dataOverrides[kind] ?? kind !== 'credentials')
  }

  const pickedPlugins = plugins.filter(pluginPicked)
  const pickedData = DATA_ORDER.filter(dataPicked)
  const hasCandidate = plugins.some(pluginMigratable) || DATA_ORDER.some(dataMigratable)

  // 5. 使用 useMutation 封装迁移提交流程
  const { mutate: handleMigrate, isPending: busy } = useMutation({
    mutationFn: async () => {
      const specs = pickedPlugins.map(entry => entry.spec)
      const kinds = pickedData

      // 阶段 A: 迁移档案数据
      let appliedCount = 0
      let failedKinds: MigrationDataKind[] = []
      if (kinds.length > 0) {
        const report = await invoke<MigrateReport>('migrate_profile_data', {
          sourceId: pickedSourceId,
          items: kinds,
        })
        appliedCount = report.applied.length
        failedKinds = report.failures.map(failure => failure.kind)
      }

      // 阶段 B: 安装插件
      let failed = 0
      if (specs.length > 0) {
        const results = await manager.install(specs)
        failed = results.filter(result => !result.ok).length
      }

      return { appliedCount, failedKinds, specCount: specs.length, failedCount: failed }
    },
    onSuccess: ({ appliedCount, failedKinds, specCount, failedCount }) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.plugins })

      if (failedKinds.length > 0) {
        const detail = failedKinds
          .map(kind => t(DATA_LABEL_KEYS[kind], { count: dataItemMap.get(kind)?.count ?? '0' }))
          .join('、')
        toast(t('profiles.migrate_partial'), { variant: 'danger', description: detail })
      }
      if (failedCount > 0) {
        toast(t('profiles.migrate_plugin_failed', { count: failedCount }), { variant: 'danger' })
      }
      // 装了插件的那一半由插件管理器的结果气泡负责提示，这里只在纯数据迁移时补一条
      else if (specCount === 0 && appliedCount > 0) {
        toast(t('profiles.migrate_success', { count: appliedCount }), { variant: 'accent' })
      }
      disclosure.confirm()
    },
    onError: (err) => {
      console.error('[ProfileMigrateDialog] migrate failed:', err)
      toast(t('profiles.migrate_failed'), { variant: 'danger', description: String(err) })
    },
  })

  const canSubmit = !busy && !analyzing && analysisReady && Boolean(pickedSourceId) && (pickedPlugins.length > 0 || pickedData.length > 0)

  return (
    <AlertDialog onOpenChange={disclosure.cancel} isOpen={disclosure.visible}>
      <AlertDialog.Backdrop>
        <AlertDialog.Container>
          <AlertDialog.Dialog data-testid="dsh-profile-migrate-dialog" className="sm:max-w-[560px]">
            <AlertDialog.CloseTrigger />
            <AlertDialog.Header>
              <AlertDialog.Icon status="accent" />
              <AlertDialog.Heading>{t('profiles.migrate_title')}</AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body className="space-y-4">
              <p className="text-xs leading-[1.7] text-muted">{t('profiles.migrate_desc')}</p>

              {/* 源档案与目标档案选择 */}
              <div className="flex justify-between items-center gap-3">
                <Select
                  variant="secondary"
                  className="flex-1"
                  selectedKey={pickedSourceId}
                  onSelectionChange={(key) => {
                    // 勾选按插件 id / 数据类目记账，两个来源可以同名：换来源必须清空，
                    // 否则上一个来源里勾过的凭据会直接套用到新来源。
                    setPickedSourceId(String(key))
                    setPluginOverrides({})
                    setDataOverrides({})
                  }}
                  isDisabled={busy}
                  aria-label={t('profiles.migrate_source')}
                  placeholder={t('profiles.migrate_source')}
                >
                  <Select.Trigger>
                    <Select.Value />
                    <Select.Indicator />
                  </Select.Trigger>
                  <Select.Popover>
                    <ListBox>
                      {sources.map(profile => (
                        <ListBox.Item id={profile.id} key={profile.id} textValue={profile.name}>
                          {profile.name}
                        </ListBox.Item>
                      ))}
                    </ListBox>
                  </Select.Popover>
                </Select>

                <ArrowRight className="size-4 shrink-0 text-muted" />

                <div className="flex-1">
                  <InputGroup fullWidth variant="secondary" className="relative">
                    <InputGroup.Input disabled className="min-w-0" value={target?.name ?? ''} />
                    <InputGroup.Suffix className="absolute right-0">
                      <Chip color="success" variant="soft">{coreVersion}</Chip>
                    </InputGroup.Suffix>
                  </InputGroup>
                </div>
              </div>

              {/* 迁移分析结果 */}
              <If
                cond={pickedSourceId}
                else={(
                  <p className="py-4 text-sm text-muted">
                    {sources.length > 0 ? t('profiles.migrate_pick_source') : t('profiles.migrate_no_source')}
                  </p>
                )}
              >
                <If cond={analyzing}>
                  <div className="flex justify-center p-6">
                    <Spinner aria-label={t('profiles.migrate_analyzing')} />
                  </div>
                </If>
                <If cond={!analyzing && error !== null}>
                  <p className="p-4 text-sm text-danger">{t('profiles.migrate_analyze_failed')}</p>
                </If>
                <If cond={!analyzing && error === null && !hasCandidate}>
                  <p className="py-4 text-sm text-muted">{t('profiles.migrate_nothing')}</p>
                </If>
                <If cond={!analyzing && error === null && hasCandidate}>
                  <Tabs defaultSelectedKey="plugins" variant="primary">
                    <Tabs.ListContainer>
                      <Tabs.List aria-label={t('profiles.migrate_title')}>
                        <Tabs.Tab id="plugins" className="h-7 px-3 text-xs">
                          {t('profiles.migrate_tab_plugins', { count: plugins.length })}
                          <Tabs.Indicator />
                        </Tabs.Tab>
                        <Tabs.Tab id="data" className="h-7 px-3 text-xs">
                          {t('profiles.migrate_tab_data')}
                          <Tabs.Indicator />
                        </Tabs.Tab>
                      </Tabs.List>
                    </Tabs.ListContainer>

                    {/* 插件列表面板 */}
                    <Tabs.Panel id="plugins">
                      <If
                        cond={plugins.length === 0}
                        then={<p className="py-4 text-sm text-muted">{t('profiles.migrate_plugins_empty')}</p>}
                        else={plugins.map((entry) => {
                          const currentVersion = installedMap.get(entry.id)
                          const installed = !pluginMigratable(entry)
                          const chip = VERDICT_CHIPS[entry.verdict]
                          const chipText = entry.targetVersion ? t(chip.key, { version: entry.targetVersion }) : t(chip.key)

                          return (
                            <div key={entry.id} className="flex justify-between items-center py-1.5">
                              <Checkbox
                                isSelected={pluginPicked(entry)}
                                isDisabled={busy || installed}
                                onChange={(value: boolean) => setPluginOverrides(prev => ({ ...prev, [entry.id]: value }))}
                                aria-label={entry.id}
                                className="shrink-0"
                              >
                                <Checkbox.Content>
                                  <Checkbox.Control>
                                    <Checkbox.Indicator />
                                  </Checkbox.Control>
                                  <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-ink">
                                    {entry.id}
                                    @
                                    {entry.version}
                                  </span>
                                </Checkbox.Content>
                              </Checkbox>

                              <div className="flex items-center gap-2">
                                <If cond={installed}>
                                  <Chip size="sm" variant="soft">
                                    {t('profiles.migrate_installed', { version: currentVersion ?? '' })}
                                  </Chip>
                                </If>

                                <If cond={!installed}>
                                  <If
                                    cond={entry.targetVersion !== undefined}
                                    then={(
                                      <Chip size="sm" color={chip.color} variant="soft" aria-label={chipText}>
                                        <If
                                          cond={entry.verdict === 'upgrade'}
                                          then={<ArrowUp className="size-2.5" />}
                                          else={<ArrowDown className="size-2.5" />}
                                        />
                                        {entry.targetVersion}
                                      </Chip>
                                    )}
                                    else={(
                                      <Chip size="sm" color={chip.color} variant="soft">
                                        {chipText}
                                      </Chip>
                                    )}
                                  />
                                </If>
                              </div>
                            </div>
                          )
                        })}
                      />
                    </Tabs.Panel>

                    {/* 档案数据面板 */}
                    <Tabs.Panel id="data">
                      {DATA_ORDER.map((kind) => {
                        const item = dataItemMap.get(kind)
                        const hasItem = item !== undefined
                        const covered = item?.covered ?? false
                        const labelText = t(DATA_LABEL_KEYS[kind], { count: item?.count ?? '0' })

                        return (
                          <div key={kind} className="flex items-center justify-between py-1.5">
                            <Checkbox
                              isSelected={dataPicked(kind)}
                              isDisabled={busy || !dataMigratable(kind)}
                              onChange={(value: boolean) => setDataOverrides(prev => ({ ...prev, [kind]: value }))}
                              aria-label={kind}
                            >
                              <Checkbox.Content>
                                <Checkbox.Control>
                                  <Checkbox.Indicator />
                                </Checkbox.Control>
                                <span className="text-[12.5px]">
                                  {DATA_FILES[kind]}
                                </span>
                                <If cond={!hasItem}>
                                  <span className="text-xs text-muted">{t('profiles.migrate_data_absent')}</span>
                                </If>
                              </Checkbox.Content>
                            </Checkbox>

                            <div className="flex items-center gap-2">
                              <span className="text-xs text-muted">{labelText}</span>
                              <If cond={covered}>
                                <span className="text-xs text-muted">{t('profiles.migrate_data_covered')}</span>
                              </If>
                              <If cond={kind === 'credentials'}>
                                <Chip size="sm" color="danger" variant="soft">
                                  {t('profiles.migrate_credentials_badge')}
                                </Chip>
                              </If>
                            </div>
                          </div>
                        )
                      })}
                    </Tabs.Panel>
                  </Tabs>
                </If>
              </If>
            </AlertDialog.Body>

            <AlertDialog.Footer className="justify-end">
              <div className="flex flex-row items-center gap-2">
                <Button data-testid="dsh-profile-migrate-cancel" variant="tertiary" isDisabled={busy} onPress={disclosure.cancel}>
                  {t('buttons.cancel')}
                </Button>
                <Button variant="primary" isDisabled={!canSubmit} onPress={() => handleMigrate()}>
                  <If cond={busy} then={<Spinner size="sm" color="current" />} />
                  <If cond={busy} then={<span>{t('profiles.migrate_busy')}</span>} else={<span>{t('profiles.migrate_confirm')}</span>} />
                </Button>
              </div>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </AlertDialog>
  )
}
