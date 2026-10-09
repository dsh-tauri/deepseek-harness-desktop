import type { ReactElement } from 'react'
import type { BackendDetection, BackendId } from '../../shared/types'
import type { HeroKernelProps } from './slot-contract'
import { ChevronDown, Chip, Menu } from 'dsh-tauri-ui/client'
import { If, useAsyncState, useStore, useWatchImmediate } from 'dsh-tauri/client'
import { useRef, useState } from 'react'
import { locale } from '../locales'
import { backendFromIdentity, isBackendAvailable, isForkedIdentity } from '../service/kernel-identity'
import { kernelStore } from '../store/modules/kernel-store'
import { KernelIcon } from './kernel-icon'

const LABELS: Record<BackendId, string> = { dsh: 'DeepSeek Harness', codex: 'Codex', claude: 'Claude' }

function backendHint(backend: BackendDetection | undefined): string | undefined {
  const status = backend === undefined || !backend.installed
    ? locale.text('kernel.unavailable')
    : backend.drift
      ? locale.text('kernel.drift')
      : backend.auth === 'missing'
        ? locale.text('kernel.authMissing')
        : backend.auth === 'unknown' ? locale.text('kernel.authUnknown') : undefined
  return [status, backend?.hint].filter(Boolean).join(' · ') || undefined
}

export function HeroKernel(props: HeroKernelProps): ReactElement {
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

  const backend = props.sessionId === undefined ? store.selected : backendFromIdentity(identity)
  const roster = new Map(store.backends.map(item => [item.id, item]))
  const workspaceBySession = new Map(workspaces.flatMap(workspace => workspace.sessionIds.map(id => [id, workspace.workspaceId] as const)))
  const workspaceId = props.sessionId === undefined ? undefined : workspaceBySession.get(props.sessionId)
  const busy = isLoading || store.phase === 'loading'
  const capable = props.canCreate()
  const disabled = busy || !capable || backend === undefined
  const items = (['dsh', 'codex', 'claude'] as const).map((id) => {
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
    if (isLoading || store.phase !== 'ready' || !capable || (id !== 'dsh' && id !== 'codex' && id !== 'claude') || !isBackendAvailable(roster.get(id)))
      return
    const preset = summary?.projectionValues?.agentPreset
    void executeImmediate(id, workspaceId === undefined
      ? summary?.cwd === undefined ? {} : { cwd: summary.cwd }
      : { workspaceId }, typeof preset === 'string' ? preset : undefined)
  }

  return (
    <div className="relative" data-bridge-kernel-picker="" aria-busy={isLoading}>
      <Menu
        open={expanded}
        anchor={(
          <Chip
            ref={chipRef}
            variant="seat"
            icon={<KernelIcon backend={backend} />}
            chevron={<ChevronDown />}
            open={expanded}
            disabled={disabled}
            aria-label={locale.text('kernel.label')}
            aria-haspopup="menu"
            aria-expanded={expanded}
            title={title}
            onClick={() => setExpanded(current => !current)}
          >
            {backend === undefined ? locale.text('kernel.pending') : LABELS[backend]}
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
