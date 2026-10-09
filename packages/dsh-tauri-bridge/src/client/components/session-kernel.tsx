import type { ReactElement } from 'react'
import type { SessionKernelProps } from './slot-contract'
import { If, useWatchImmediate } from 'dsh-tauri/client'
import { locale } from '../locales'
import { backendFromIdentity, kernelFromList } from '../service/kernel-identity'
import { KernelIcon } from './kernel-icon'

export function SessionKernel(props: SessionKernelProps): ReactElement {
  locale.useLocale()
  const identity = props.useSessions(state => kernelFromList(state, props.sessionId))
  useWatchImmediate([props.sessionId, identity] as const, ([sessionId, value]) => {
    if (value === undefined)
      void props.ensureProjection(sessionId)
  })
  const backend = backendFromIdentity(identity)
  const label = backend === 'codex' ? 'Codex' : 'Claude'
  return (
    <If
      cond={backend === 'codex' || backend === 'claude'}
      then={(
        <span className="inline-flex shrink-0 text-tertiary" role="img" aria-label={`${label} ${locale.text('kernel.label')}`} title={label} data-bridge-kernel={backend}>
          <KernelIcon backend={backend} />
        </span>
      )}
    />
  )
}
