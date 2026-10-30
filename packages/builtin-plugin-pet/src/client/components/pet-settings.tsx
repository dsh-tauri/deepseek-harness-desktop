import type { ChangeEvent, ReactElement } from 'react'
import type { PetActionResult, PetListItem } from '../service/pet.types'
import { ArrowRightFromSquare, Button, Globe, Icon, Input, Modal, Plus, SegmentedControl, Switch } from 'dsh-tauri-ui/client'
import { useStore, useWatchImmediate } from 'dsh-tauri/client'
import { useEffect, useId, useRef, useState } from 'react'
import { PET_DEFAULT_SIZE, PET_SIZE_MAX, PET_SIZE_MIN, PET_SIZE_STEP } from '../constants'
import { locale } from '../locales'
import {
  choosePet,
  clearPetSelection,
  deletePet,
  enablePet,
  importPetArchive,
  importPetRepository,
  loadForceXwayland,
  loadPetCatalog,
  loadPetOverlaySupported,
  loadPetUpdates,
  openCommunityShare,
  resizePet,
  toggleForceXwayland,
  togglePet,
  togglePetThrow,
  updatePetRepository,
} from '../service/pet'
import { store } from '../store'
import { PetCard } from './pet-card'

const TAB_OPTIONS = [
  { value: 'pets', label: 'Pets' },
  { value: 'codex', label: 'Codex' },
] as const

/** settings.section 槽位注入给设置分区的属性。 */
export interface PetSettingsProps {
  close?: () => void
  onCreate: (close?: () => void) => Promise<PetActionResult>
}

/** 读取 .zip 归档为 base64（桌面端命令按字符串收包）。 */
function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const value = String(reader.result ?? '')
      const comma = value.indexOf(',')
      resolve(comma >= 0 ? value.slice(comma + 1) : value)
    }
    reader.onerror = () => reject(new Error('PET_FILE_READ_FAILED: failed to read pet archive'))
    reader.readAsDataURL(file)
  })
}

/** 桌宠设置页：预设 / Chat / Codex 三类宠物卡片（选择、启用、取消选择）、开关、大小滑条与导入。 */
export function PetSettings(props: PetSettingsProps): ReactElement {
  locale.useLocale()
  const { status, presetPets, petUpdates, chatPets, codexPets, catalogLoaded, overlaySupported, forceXwayland } = useStore(store.pet)
  const [tab, setTab] = useState<'pets' | 'codex'>('pets')
  const [busy, setBusy] = useState(() => !catalogLoaded)
  const [error, setError] = useState<string | null>(null)
  const [repositoryOpen, setRepositoryOpen] = useState(false)
  const [repository, setRepository] = useState('')
  const [repositoryError, setRepositoryError] = useState<string | null>(null)
  const repositoryPendingRef = useRef(false)
  const repositoryId = useId()
  const [size, setSize] = useState(status?.pet_size ?? PET_DEFAULT_SIZE)
  // 切换只落盘，本次进程不会有任何变化，提示重启是用户唯一能看到的反馈。
  const [xwaylandRestart, setXwaylandRestart] = useState(false)
  const tabsId = useId()
  const fileRef = useRef<HTMLInputElement>(null)
  const committedSizeRef = useRef<number | null>(null)
  const enabled = Boolean(status?.enabled)
  const active = status?.active_pet ?? ''
  const statusSize = status?.pet_size ?? PET_DEFAULT_SIZE
  const throwEnabled = Boolean(status?.throw_enabled)

  // 宿主侧尺寸变化同步到本地滑条，正在拖动的本地值不被覆盖。
  useWatchImmediate(statusSize, () => {
    if (statusSize !== committedSizeRef.current)
      setSize(statusSize)
  })

  // 判定在进程生命周期内不变，读到过就不再重复发起；上次失败（仍为 null）时重试。
  useEffect(() => {
    if (overlaySupported === null)
      void loadPetOverlaySupported()
  }, [overlaySupported])

  // 同上的重试语义：读不到只让开关不出现。
  useEffect(() => {
    if (forceXwayland === null)
      void loadForceXwayland()
  }, [forceXwayland])

  useEffect(() => {
    let cancelled = false
    void loadPetCatalog().then((result) => {
      if (cancelled)
        return
      setBusy(false)
      if (!result.ok)
        setError(locale.text('listFailed'))
      else
        void loadPetUpdates()
    })
    return () => {
      cancelled = true
    }
  }, [])

  async function run(action: () => Promise<PetActionResult>, errorKey: Parameters<typeof locale.text>[0]): Promise<void> {
    if (busy)
      return
    setBusy(true)
    setError(null)
    const result = await action()
    if (!result.ok)
      setError(locale.text(errorKey))
    setBusy(false)
  }

  async function enablePreset(id: string): Promise<void> {
    if (active !== id)
      await run(() => enablePet({ id }), 'setPetFailed')
  }

  async function choose(id: string): Promise<void> {
    if (active !== id)
      await run(() => choosePet({ id }), 'setPetFailed')
  }

  async function clearSelection(): Promise<void> {
    if (active !== '')
      await run(clearPetSelection, 'clearFailed')
  }

  /** 删除导入的宠物：预设页删的是远端登记，Chat / Codex 页删的是本地目录。 */
  async function remove(id: string): Promise<void> {
    await run(() => deletePet({ id }), 'deleteFailed')
  }

  async function toggleEnabled(): Promise<void> {
    await run(() => togglePet({ enabled: !enabled }), 'toggleFailed')
  }

  /** 切换抛射：关闭（默认）时宠物松手即停，不再飞行与撞边回弹（issue #930）。 */
  async function toggleThrow(): Promise<void> {
    await run(() => togglePetThrow({ enabled: !throwEnabled }), 'throwFailed')
  }

  /** 切换「强制 XWayland」：应用全局设置，下次启动生效。 */
  async function toggleXwayland(): Promise<void> {
    await run(async () => {
      const result = await toggleForceXwayland({ enabled: !forceXwayland })
      if (result.ok)
        setXwaylandRestart(true)
      return result
    }, 'xwaylandFailed')
  }

  /** 社区分享：在系统浏览器中打开 Codex 宠物社区站点。 */
  async function shareCommunity(): Promise<void> {
    await run(openCommunityShare, 'communityShareFailed')
  }

  async function commitSize(value: number): Promise<void> {
    setError(null)
    const result = await resizePet({ size: value })
    if (result.ok)
      committedSizeRef.current = value
    else
      setError(locale.text('setSizeFailed'))
  }

  async function createPet(): Promise<void> {
    if (busy)
      return
    setBusy(true)
    setError(null)
    const result = await props.onCreate(props.close)
    if (!result.ok) {
      setError(locale.text('createFailed'))
      setBusy(false)
    }
  }

  async function importRepository(): Promise<void> {
    if (busy || repositoryPendingRef.current)
      return
    repositoryPendingRef.current = true
    setBusy(true)
    setRepositoryError(null)
    setError(null)
    try {
      const result = await importPetRepository({ repository })
      if (result.ok) {
        setRepositoryOpen(false)
        setRepository('')
      }
      else {
        setRepositoryError(locale.text(result.error === 'PET_REPOSITORY_INVALID' ? 'repositoryInvalid' : 'repositoryImportFailed'))
      }
    }
    catch {
      setRepositoryError(locale.text('repositoryImportFailed'))
    }
    finally {
      repositoryPendingRef.current = false
      setBusy(false)
    }
  }

  async function onImport(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file || busy)
      return
    setBusy(true)
    setError(null)
    try {
      const result = await importPetArchive({ name: file.name, data: await readAsBase64(file) })
      if (!result.ok)
        setError(locale.text('importFailed'))
    }
    catch (importError) {
      console.error('[dsh-tauri-pet] import failed:', importError)
      setError(locale.text('importFailed'))
    }
    finally {
      setBusy(false)
    }
  }

  const cards = (items: readonly PetListItem[]) => items.map(item => (
    <PetCard
      key={item.id}
      thumbnail={item.thumbnail}
      thumbnailType={item.thumbnail_type ?? 'spritesheet'}
      name={item.name}
      desc={item.description ?? ''}
      active={active === item.id}
      disabled={busy}
      actionLabel={locale.text(active === item.id ? 'clear' : 'select')}
      onAction={() => { void (active === item.id ? clearSelection() : choose(item.id)) }}
      deleteLabel={locale.text('delete')}
      onDelete={() => { void remove(item.id) }}
    />
  ))

  const petsPanel = (
    <>
      {busy && presetPets.length === 0 && chatPets.length === 0
        ? <div className="px-[16px] py-[24px] text-center text-[13px] leading-[20px] text-secondary">{locale.text('loading')}</div>
        : (
            <div className="flex flex-col gap-[12px]">
              {presetPets.map(item => (
                <PetCard
                  key={item.id}
                  thumbnail={item.image ?? undefined}
                  name={item.name}
                  desc={item.desc ?? ''}
                  active={active === item.id}
                  disabled={busy}
                  actionLabel={locale.text(active === item.id ? 'clear' : 'enable')}
                  onAction={() => { void (active === item.id ? clearSelection() : enablePreset(item.id)) }}
                  deleteLabel={item.remote ? locale.text('delete') : undefined}
                  onDelete={item.remote ? () => { void remove(item.id) } : undefined}
                  updateLabel={locale.text('update')}
                  onUpdate={item.remote && petUpdates.includes(item.id) ? () => { void run(() => updatePetRepository({ id: item.id }), 'updateFailed') } : undefined}
                />
              ))}
              {cards(chatPets)}
            </div>
          )}
    </>
  )

  const codexPanel = (
    <div className="flex flex-col gap-[12px]">
      {codexPets.length === 0
        ? <div className="px-[16px] py-[24px] text-center text-[13px] leading-[20px] rounded-[12px] border border-dashed border-border-weak text-secondary">{locale.text('emptyImported')}</div>
        : cards(codexPets)}
    </div>
  )

  return (
    <div data-pet-page="1" className="flex flex-col gap-[12px] text-primary">
      {/* 开启并重启后 overlaySupported 变回 true、提示消失，没有 forceXwayland 这一支就再也关不掉。
          xwaylandRestart 一支覆盖在 XWayland 下关闭开关的情形：前两个条件同时落空，
          整块会连同刚点过的按钮一起卸载，重启提示无从显示。
          macOS / Windows 上三个条件都不成立，整块不渲染。 */}
      {overlaySupported === false || forceXwayland || xwaylandRestart
        ? (
            <div className="flex flex-col gap-[8px] px-[12px] py-[10px] text-[12px] leading-[18px] rounded-[10px] border border-border-weak text-secondary [&_p]:m-0" role="status">
              {overlaySupported === false ? <p>{locale.text('waylandNotice')}</p> : null}
              <div className="flex items-center flex-wrap gap-[8px]">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => { void toggleXwayland() }}
                >
                  {forceXwayland ? locale.text('xwaylandDisable') : locale.text('xwaylandEnable')}
                </Button>
              </div>
              {xwaylandRestart
                ? <p className="m-0 px-[10px] py-[8px] text-[13px] leading-[20px] rounded-[8px] border border-[color-mix(in_srgb,var(--dsw-alias-state-business-primary)_35%,transparent)] bg-[color-mix(in_srgb,var(--dsw-alias-state-business-primary)_8%,transparent)] text-primary">{locale.text('xwaylandRestart')}</p>
                : null}
              <p className="text-[12px] leading-[18px] text-tertiary">{locale.text('xwaylandDesc')}</p>
            </div>
          )
        : null}
      <div className="flex items-center justify-between gap-[16px] flex-wrap mt-[4px]">
        <SegmentedControl
          id={tabsId}
          label={locale.text('name')}
          value={tab}
          options={TAB_OPTIONS}
          onChange={next => setTab(next === 'codex' ? 'codex' : 'pets')}
        />
        <div className="flex items-center gap-[6px]">
          {tab === 'pets'
            ? (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    icon={<Icon size={14} as={Plus} />}
                    disabled={busy}
                    onClick={() => { void createPet() }}
                  >
                    {locale.text('create')}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      setRepositoryError(null)
                      setRepositoryOpen(true)
                    }}
                  >
                    {locale.text('importRepository')}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => { void toggleEnabled() }}
                  >
                    {enabled ? locale.text('closePet') : locale.text('enablePet')}
                  </Button>
                </>
              )
            : (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    icon={<Icon size={14} as={ArrowRightFromSquare} />}
                    disabled={busy}
                    onClick={() => fileRef.current?.click()}
                  >
                    {locale.text('import')}
                  </Button>
                  <input
                    ref={fileRef}
                    type="file"
                    accept=".zip"
                    hidden
                    disabled={busy}
                    onChange={(event) => { void onImport(event) }}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    icon={<Icon size={14} as={Globe} />}
                    disabled={busy}
                    onClick={() => { void shareCommunity() }}
                  >
                    {locale.text('communityShare')}
                  </Button>
                </>
              )}
        </div>
      </div>
      <p className="m-0 text-[13px] leading-[20px] text-secondary">
        {tab === 'pets' ? locale.text('tabInstalledDesc') : locale.text('tabCodexDesc')}
      </p>
      <div id={`${tabsId}-${tab}-panel`} role="tabpanel" aria-labelledby={`${tabsId}-${tab}`}>
        {tab === 'pets' ? petsPanel : codexPanel}
      </div>
      <Modal
        open={repositoryOpen}
        title={locale.text('importRepository')}
        description={locale.text('repositoryHint')}
        closeLabel={locale.text('close')}
        onClose={() => {
          if (!repositoryPendingRef.current)
            setRepositoryOpen(false)
        }}
        footer={(
          <>
            <Button variant="outline" disabled={busy} onClick={() => setRepositoryOpen(false)}>{locale.text('cancel')}</Button>
            <Button type="submit" form={repositoryId} variant="primary" disabled={busy}>
              {locale.text(busy ? 'repositoryImporting' : 'importRepository')}
            </Button>
          </>
        )}
      >
        <form
          id={repositoryId}
          className="flex flex-col gap-[12px]"
          aria-busy={busy}
          onSubmit={(event) => {
            event.preventDefault()
            void importRepository()
          }}
        >
          <label htmlFor={`${repositoryId}-input`}>{locale.text('repositoryLabel')}</label>
          <Input
            id={`${repositoryId}-input`}
            data-modal-autofocus
            value={repository}
            placeholder="owner/repo"
            disabled={busy}
            aria-invalid={Boolean(repositoryError)}
            aria-describedby={repositoryError ? `${repositoryId}-error` : undefined}
            onChange={(event) => {
              setRepository(event.target.value)
              setRepositoryError(null)
            }}
          />
          {repositoryError ? <div id={`${repositoryId}-error`} className="text-[12px] leading-[18px] text-error" role="alert">{repositoryError}</div> : null}
        </form>
      </Modal>
      {error ? <div className="text-[12px] leading-[18px] text-error" role="alert">{error}</div> : null}
      <div className="flex items-center gap-[12px]">
        <span className="flex-none font-medium">{locale.text('sizeLabel')}</span>
        <input
          type="range"
          className="flex-1 accent-brand cursor-pointer"
          min={PET_SIZE_MIN}
          max={PET_SIZE_MAX}
          step={PET_SIZE_STEP}
          value={size}
          aria-label={locale.text('sizeLabel')}
          onChange={(event) => {
            const value = Number(event.target.value)
            setSize(value)
            void commitSize(value)
          }}
        />
      </div>
      <p className="m-0 text-[12px] leading-[18px] text-secondary">{locale.text('sizeHint')}</p>
      <div className="flex items-center justify-between gap-[12px]">
        <span className="flex-none font-medium">{locale.text('throwLabel')}</span>
        <Switch
          checked={throwEnabled}
          label={locale.text('throwLabel')}
          onChange={() => { void toggleThrow() }}
        />
      </div>
      <p className="m-0 text-[12px] leading-[18px] text-secondary">{locale.text('throwHint')}</p>
    </div>
  )
}
