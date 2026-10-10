import type { ReactElement } from 'react'
import type { NativeTurnOptions } from '../../shared/native-model'
import type { KernelBinding } from '../../shared/types'
import type { OfficialModelSelectFace } from '../types/kernel-model'
import type { ModelKernelProps } from './slot-contract'
import { Select } from 'dsh-tauri-ui/client'
import { useWatchImmediate } from 'dsh-tauri/client'
import { createElement, useState } from 'react'
import { locale } from '../locales'
import { backendFromIdentity, isForkedIdentity } from '../service/kernel-identity'
import { hasModelLockFace } from '../service/kernel-model'
import { isNativeTurnOptions } from '../service/kernel-model.utils'

export function ModelKernel(props: ModelKernelProps): ReactElement {
  if (!hasModelLockFace(props))
    return createElement(props.Original, { ...props })
  return <VerifiedModelKernel {...props} />
}

function VerifiedModelKernel(props: ModelKernelProps & OfficialModelSelectFace): ReactElement {
  locale.useLocale()
  const identity = props.useProjection('bridgeKernel')
  const current = props.useProjection('bridgeModel')
  useWatchImmediate([props.sessionId, identity, current] as const, ([sessionId, value, selection]) => {
    if (value === undefined || (backendFromIdentity(value) !== 'dsh' && !isNativeTurnOptions(selection)))
      void props.ensureProjection(sessionId)
  })
  const backend = backendFromIdentity(identity)
  if (backend === 'dsh')
    return createElement(props.Original, { ...props })
  if (backend === undefined || !isNativeTurnOptions(current) || isForkedIdentity(identity, props.sessionId)
    || !props.canSelectNativeModel()) {
    const label = backend === undefined ? locale.text('kernel.label') : locale.text('kernel.modelDefault')
    return (
      <Select
        variant="composerTrigger"
        options={[{ value: label, label }]}
        value={label}
        onChange={() => {}}
        disabled
        title={isForkedIdentity(identity, props.sessionId) ? locale.text('kernel.fork') : locale.text('kernel.pending')}
        data-bridge-kernel-model="locked"
      />
    )
  }
  const binding = identity as KernelBinding
  return <NativeModelKernel key={`${props.sessionId}:${binding.nativeSessionId}`} {...props} binding={binding} current={current} />
}

function NativeModelKernel(props: ModelKernelProps & OfficialModelSelectFace & { binding: KernelBinding, current: NativeTurnOptions }): ReactElement {
  const { sessionId, binding, current, createNativeModelDirectory, syncNativeModel } = props
  const [directory] = useState(() => createNativeModelDirectory(sessionId, binding, current))
  useWatchImmediate([sessionId, binding.backend, binding.nativeSessionId, current.model, current.reasoningEffort] as const, () => {
    syncNativeModel(sessionId, binding, current)
  })
  return (
    <span title={locale.text('kernel.modelNextTurn')} data-bridge-kernel-model="native">
      {createElement(props.Original, {
        ...props,
        directory,
        load: () => { void props.loadNativeModels(sessionId, binding) },
        select: (selection: Parameters<OfficialModelSelectFace['select']>[0]) => props.locked || !props.available
          ? Promise.resolve(undefined)
          : props.selectNativeModel(sessionId, binding, selection),
      })}
    </span>
  )
}
