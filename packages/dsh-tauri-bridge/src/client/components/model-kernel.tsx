import type { ReactElement } from 'react'
import type { ModelKernelProps } from './slot-contract'
import { Select } from 'dsh-tauri-ui/client'
import { useWatchImmediate } from 'dsh-tauri/client'
import { createElement } from 'react'
import { locale } from '../locales'
import { backendFromIdentity } from '../service/kernel-identity'
import { hasModelLockFace } from '../service/kernel-model'

export function ModelKernel(props: ModelKernelProps): ReactElement {
  if (!hasModelLockFace(props))
    return createElement(props.Original, { ...props })
  return <VerifiedModelKernel {...props} />
}

function VerifiedModelKernel(props: ModelKernelProps): ReactElement {
  locale.useLocale()
  const identity = props.useProjection('bridgeKernel')
  useWatchImmediate([props.sessionId, identity] as const, ([sessionId, value]) => {
    if (value === undefined)
      void props.ensureProjection(sessionId)
  })
  const backend = backendFromIdentity(identity)
  if (backend === 'dsh')
    return createElement(props.Original, { ...props })
  const label = backend === undefined ? locale.text('kernel.label') : `bridge/${backend}`
  return (
    <Select
      variant="composerTrigger"
      options={[{ value: label, label }]}
      value={label}
      onChange={() => {}}
      disabled
      title={backend === undefined ? locale.text('kernel.pending') : locale.text('kernel.immutable')}
      data-bridge-kernel-model="locked"
    />
  )
}
