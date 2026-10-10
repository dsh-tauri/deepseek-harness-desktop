import type { ReactElement } from 'react'
import type { BackendDetection, BackendId } from '../../shared/types'
import type { HeroKernelProps } from './slot-contract'
import { ChevronDown, Chip, Menu, Xmark } from 'dsh-tauri-ui/client'
import { If, useAsyncState, useStore, useWatchImmediate } from 'dsh-tauri/client'
import { useRef, useState } from 'react'
import { locale } from '../locales'
import { backendFromIdentity, isBackendAvailable, isForkedIdentity } from '../service/kernel-identity'
import { kernelContentAvailable } from '../service/kernel-version'
import { kernelStore, rememberedKernel } from '../store/modules/kernel-store'
import { KernelIcon } from './kernel-icon'

const LABELS: Record<BackendId, string> = { dsh: 'DeepSeek Harness', codex: 'Codex', claude: 'Claude' }
const CHOICES = ['codex', 'claude'] as const

function backendHint(backend: BackendDetection | undefined): string | undefined {
  if (backend === undefined || !backend.installed)
    return locale.text('kernel.unavailable')
  if (backend.bridgeReady === false)
    return locale.text('kernel.coreUnavailable')
  if (backend.drift)
    return locale.text('kernel.drift')
  if (backend.auth === 'missing')
    return locale.text('kernel.authMissing')
  return undefined
}

function pillClass(disabled: boolean, expanded: boolean): string {
  const base = 'group inline-flex h-[28px] items-center rounded-sm whitespace-nowrap leading-none [&>span]:inline-flex [&>span]:h-full [&>span]:items-center'
  if (disabled)
    return `${base} text-[var(--dsw-alias-label-quaternary)]`
  return `${base} text-primary ${expanded ? 'bg-hover' : 'hover:bg-hover'}`
}

export function HeroKernel(props: HeroKernelProps): ReactElement | null {
  locale.useLocale()
  const store = useStore(kernelStore)
  const identity = props.useProjection('bridgeKernel')
  const summary = props.useSessions(state => props.sessionId === undefined ? undefined : state.byId[props.sessionId])
  const workspaces = props.useWorkspaces(state => state.items)
  const [expanded, setExpanded] = useState(false)
  const chipRef = useRef<HTMLButtonElement>(null)
  const { isLoading, error, executeImmediate } = useAsyncState(props.createSession, undefined, {
    immediate: false,
    onSuccess: () => setExpanded(false),
  })
  useWatchImmediate([props.sessionId, identity] as const, ([sessionId, value]) => {
    if (sessionId !== undefined && value === undefined)
      void props.ensureProjection(sessionId)
  })

  if (store.phase === 'ready' && !kernelContentAvailable(store.backends))
    return null

  const remembered = props.sessionId === undefined || identity === null
  const backend = remembered ? rememberedKernel(store.selected) : backendFromIdentity(identity)
  const roster = new Map(store.backends.map(item => [item.id, item]))
  const workspaceBySession = new Map(workspaces.flatMap(workspace => workspace.sessionIds.map(id => [id, workspace.workspaceId] as const)))
  const workspaceId = props.sessionId === undefined ? undefined : workspaceBySession.get(props.sessionId)
  const busy = isLoading || store.phase === 'loading'
  const capable = props.canCreate()
  const clearable = (backend === 'codex' || backend === 'claude') && !busy && capable
  const disabled = busy || !capable || (!remembered && backend === undefined)
  const items = CHOICES.map((id) => {
    const hint = backendHint(roster.get(id))
    return {
      id,
      label: (
        <>
          {LABELS[id]}
          <If
            cond={hint !== undefined}
            then={(
              <span className="text-tertiary">{` · ${hint}`}</span>
            )}
          />
        </>
      ),
      icon: <KernelIcon backend={id} />,
      disabled: isLoading || !capable || store.phase !== 'ready' || !isBackendAvailable(roster.get(id)),
    }
  })
  const forked = isForkedIdentity(identity, props.sessionId)
  const title = forked
    ? locale.text('kernel.fork')
    : [
        locale.text('kernel.selectorScope'),
        backend === 'codex' || backend === 'claude' ? locale.text('kernel.immutable') : undefined,
      ].filter(Boolean).join(' · ')
  const failure = error == null ? store.error : error instanceof Error ? error.message : String(error)

  function select(id: string): void {
    if (isLoading || store.phase !== 'ready' || !capable || (id !== 'codex' && id !== 'claude') || !isBackendAvailable(roster.get(id)))
      return
    const preset = summary?.projectionValues?.agentPreset
    void executeImmediate(id, workspaceId === undefined
      ? summary?.cwd === undefined ? {} : { cwd: summary.cwd }
      : { workspaceId }, typeof preset === 'string' ? preset : undefined)
  }

  function clear(): void {
    kernelStore.select(undefined)
    setExpanded(false)
    if (remembered || isLoading || store.phase !== 'ready' || !capable)
      return
    const preset = summary?.projectionValues?.agentPreset
    void executeImmediate('dsh', workspaceId === undefined
      ? summary?.cwd === undefined ? {} : { cwd: summary.cwd }
      : { workspaceId }, typeof preset === 'string' ? preset : undefined)
  }

  return (
    <div className="relative inline-flex items-center" data-bridge-kernel-picker="" aria-busy={isLoading}>
      <span className={pillClass(disabled, expanded)} data-bridge-kernel-pill="">
        <Menu
          open={expanded}
          anchor={(
            <Chip
              ref={chipRef}
              variant="seat"
              className={`h-full rounded-none bg-transparent hover:not-disabled:bg-transparent aria-expanded:bg-transparent${clearable ? ' pr-0' : ''}`}
              icon={<KernelIcon backend={backend} />}
              chevron={clearable ? undefined : <ChevronDown />}
              open={expanded}
              disabled={disabled}
              aria-label={locale.text('kernel.label')}
              aria-haspopup="menu"
              aria-expanded={expanded}
              title={title}
              onClick={() => setExpanded(current => !current)}
            >
              {backend === undefined ? remembered ? locale.text('kernel.select') : locale.text('kernel.pending') : LABELS[backend]}
            </Chip>
          )}
          items={items}
          selectedId={backend}
          onSelect={select}
          onClose={() => setExpanded(false)}
          portal
          side="bottom"
          getAnchorRect={() => chipRef.current?.getBoundingClientRect() ?? null}
        />
        <If
          cond={clearable}
          then={(
            <button
              type="button"
              disabled={busy}
              aria-label={locale.text('kernel.clear')}
              title={locale.text('kernel.clear')}
              data-bridge-kernel-clear=""
              className="inline-flex shrink-0 cursor-pointer items-center self-stretch border-none bg-transparent pl-[4px] pr-[8px] text-[var(--dsw-alias-label-caption)] disabled:cursor-default [&_svg]:w-[11px] [&_svg]:h-[11px]"
              onClick={clear}
            >
              <span className="inline-flex group-hover:hidden group-focus-visible:hidden" data-bridge-kernel-chevron="">
                <ChevronDown />
              </span>
              <span className="hidden group-hover:inline-flex group-focus-visible:inline-flex" data-bridge-kernel-clear-icon="">
                <Xmark />
              </span>
            </button>
          )}
        />
      </span>
      <If
        cond={failure != null}
        then={(
          <span role="alert" className="text-secondary text-[13px]">
            {failure}
            <button type="button" disabled={busy} onClick={() => { void props.refreshBackends() }}>
              {locale.text('kernel.retry')}
            </button>
          </span>
        )}
      />
    </div>
  )
}
