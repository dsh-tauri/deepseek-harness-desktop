import type { ReactElement } from 'react'
import type { SessionKernelHoverProps } from './slot-contract'
import { If, useStore, useWatchImmediate } from 'dsh-tauri/client'
import { locale } from '../locales'
import { backendFromIdentity, isForkedIdentity, kernelFromList } from '../service/kernel-identity'
import { kernelContentAvailable } from '../service/kernel-version'
import { kernelStore } from '../store/modules/kernel-store'
import { KernelIcon } from './kernel-icon'

const LABELS = { dsh: 'DeepSeek Harness', codex: 'Codex', claude: 'Claude' }

export function SessionKernelHover(props: SessionKernelHoverProps): ReactElement | null {
  locale.useLocale()
  const store = useStore(kernelStore)
  const identity = props.useSessions(state => kernelFromList(state, props.sessionId))
  useWatchImmediate([props.sessionId, identity] as const, ([sessionId, value]) => {
    if (value === undefined)
      void props.ensureProjection(sessionId)
  })
  if (store.phase === 'ready' && !kernelContentAvailable(store.backends))
    return null
  const backend = backendFromIdentity(identity)
  const forked = isForkedIdentity(identity, props.sessionId)
  return (
    <div className="flex items-center gap-[8px] text-tertiary" data-bridge-kernel-hover={backend ?? 'unknown'}>
      <KernelIcon backend={backend} />
      <span>{backend === undefined ? locale.text('kernel.pending') : `${locale.text('kernel.label')}: ${LABELS[backend]}`}</span>
      <If cond={forked} then={<span>{locale.text('kernel.fork')}</span>} />
    </div>
  )
}
