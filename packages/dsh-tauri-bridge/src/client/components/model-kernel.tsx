import type { ReactElement } from 'react'
import type { ModelKernelProps } from './slot-contract'
import { If, useWatchImmediate } from 'dsh-tauri/client'
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
  const locked = backend !== 'dsh'
  return (
    <>
      {createElement(props.Original, { ...props, locked: props.locked || locked })}
      <If
        cond={locked}
        then={(
          <span className="text-tertiary text-[13px]" data-bridge-kernel-model="locked">
            {backend === undefined ? locale.text('kernel.pending') : locale.text('kernel.immutable')}
          </span>
        )}
      />
    </>
  )
}
