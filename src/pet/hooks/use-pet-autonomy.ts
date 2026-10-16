import type { DshPetConfig, PetGeometry, PetRef, PetRenderMotion } from 'dsh-pet-component'
import type { CSSProperties } from 'react'
import type { PetSource } from './use-pet-source'
import { useIntervalFn, useMount, useUnmount, useWatch } from '@reause/core'
import { invoke } from '@tauri-apps/api/core'
import { useConfig } from 'dsh-pet-component'
import { useRef, useState } from 'react'
import { reportPetIssue } from '../utils/log'

type Direction = 'left' | 'right' | 'up' | 'down'
type InteractionAction = 'walk' | 'squeeze' | 'stretch' | 'move'

interface InteractionPose {
  animation?: string | null
  facing?: Direction
  mirror?: boolean
  canvas?: [number, number]
  foot?: [number, number]
  contact?: [number, number] | null
  offset?: [number, number]
}

export interface InteractionConfig extends DshPetConfig {
  interactions?: {
    version: 1
    fallback?: string
    actions?: Partial<Record<InteractionAction, InteractionPose & {
      directions?: Partial<Record<Direction, InteractionPose>>
    }>>
  }
}

export interface InteractionFrame {
  action: InteractionAction
  direction: Direction
  edge: 'left' | 'right' | 'top' | 'bottom'
  contact: { x: number, y: number } | null
}

const EMPTY_CONFIG: InteractionConfig = {}

function pair(value: unknown, fallback: [number, number], min: number, max: number): [number, number] {
  return Array.isArray(value) && value.length === 2 && value.every(n => typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max)
    ? value as [number, number]
    : fallback
}

function animationName(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim())
    return value
  if (Array.isArray(value))
    return value.find(item => typeof item === 'string' && item.trim())
}

export function interactionPlayback(config: InteractionConfig | null, frame: InteractionFrame | null, geometry: PetGeometry | null, failed: string[] = []) {
  const settings = config?.interactions?.version === 1 ? config.interactions : undefined
  const action = frame ? settings?.actions?.[frame.action] : undefined
  const pose = { ...action, ...action?.directions?.[frame?.direction ?? 'left'] }
  const requested = animationName(pose.animation)
  const configured = requested !== undefined && !failed.includes(requested)
  const fallback = [settings?.fallback, config?.motions?.idle, config?.animations?.motions?.idle, config?.animations?.idle]
    .map(animationName)
    .find(name => name !== undefined && !failed.includes(name))
  const animation = configured ? requested : fallback
  const active = frame !== null && animation !== undefined
  const mirrored = configured && pose.mirror !== false && (
    (pose.facing === 'left' && frame?.direction === 'right')
    || (pose.facing === 'right' && frame?.direction === 'left')
  )
  const style: CSSProperties & Record<string, string> = {}
  if (active && configured && geometry) {
    const canvas = pair(pose.canvas, [500, 500], 1, 8192)
    const scale = Math.min(geometry.width / canvas[0], geometry.height / canvas[1])
    const width = canvas[0] * scale
    const height = canvas[1] * scale
    const foot = pair(pose.foot, [0.5, 1], 0, 1)
    const contact = pose.contact == null ? null : pair(pose.contact, foot, 0, 1)
    const touch = frame.action !== 'walk' && contact !== null && frame.contact !== null
    const anchor = touch ? contact : foot
    const target = touch ? frame.contact! : { x: (geometry.body.left + geometry.body.right) / 2, y: geometry.body.bottom }
    const offset = pair(pose.offset, [0, 0], -1, 1)
    style['--pet-interaction-x'] = `${target.x - geometry.x - (geometry.width - width) / 2 - (mirrored ? 1 - anchor[0] : anchor[0]) * width + offset[0] * width}px`
    style['--pet-interaction-y'] = `${target.y - geometry.y - (geometry.height - height) / 2 - anchor[1] * height + offset[1] * height}px`
  }
  return {
    active,
    animation,
    configured,
    mirrored: active ? mirrored : undefined,
    style,
    config: active ? { ...config, motions: { ...config?.motions, 'moving-left': animation, 'moving-right': animation } } : config,
  }
}

export function usePetAutonomy(pet: PetRef, enabled: boolean, isBusy: () => boolean, source?: PetSource | null) {
  const { config } = useConfig<InteractionConfig>(source?.kind === 'dsh' ? source.config : EMPTY_CONFIG)
  const [frame, setFrame] = useState<InteractionFrame | null>(null)
  const [failed, setFailed] = useState<string[]>([])
  const pendingRef = useRef(false)
  const retryAtRef = useRef(0)
  const generationRef = useRef(0)
  const disposedRef = useRef(false)
  const resetRef = useRef(false)
  const ownedRef = useRef(false)
  const currentRef = useRef({ enabled, isBusy })
  currentRef.current = { enabled, isBusy }
  const currentFrame = enabled && !isBusy() ? frame : null
  const playback = interactionPlayback(source?.kind === 'dsh' ? config : null, currentFrame, pet.geometry, failed)
  const motionKey = playback.active ? `${currentFrame?.action}:${currentFrame?.direction}:${playback.animation}` : ''

  useMount(() => {
    disposedRef.current = false
  })
  useWatch(motionKey, (key) => {
    if (key) {
      ownedRef.current = true
      pet.motion({ type: 'moving-left', loop: true, replay: true })
    }
    else if (ownedRef.current) {
      ownedRef.current = false
      pet.clear()
    }
  }, { immediate: true })

  const timer = useIntervalFn(() => {
    void step()
  }, 50, { immediate: false })
  useWatch(enabled, (active) => {
    generationRef.current++
    retryAtRef.current = 0
    if (active) {
      timer.resume()
    }
    else {
      timer.pause()
      setFrame(null)
    }
    void step()
  }, { immediate: true })
  useWatch(source, () => {
    generationRef.current++
    resetRef.current = true
    retryAtRef.current = 0
    setFrame(null)
    setFailed([])
    void step()
  })
  useUnmount(() => {
    disposedRef.current = true
    generationRef.current++
    if (ownedRef.current)
      pet.clear()
  })

  async function step(): Promise<void> {
    const paused = resetRef.current || !currentRef.current.enabled || currentRef.current.isBusy()
    if (pendingRef.current || disposedRef.current || Date.now() < retryAtRef.current)
      return
    pendingRef.current = true
    resetRef.current = false
    const generation = generationRef.current
    try {
      const next = await invoke<InteractionFrame | null>('step_pet_autonomy', {
        body: pet.geometry?.body ?? null,
        paused,
      })
      if (generation !== generationRef.current || disposedRef.current)
        return
      const accepted = !paused && currentRef.current.enabled && !currentRef.current.isBusy() ? next ?? null : null
      setFrame(previous => JSON.stringify(previous) === JSON.stringify(accepted) ? previous : accepted)
    }
    catch (error) {
      if (generation === generationRef.current && !disposedRef.current) {
        setFrame(null)
        retryAtRef.current = Date.now() + 20_000
        reportPetIssue('autonomy', error)
      }
    }
    finally {
      pendingRef.current = false
      if (generation !== generationRef.current && !disposedRef.current)
        void step()
    }
  }

  function onMotionChange(motion: PetRenderMotion): void {
    if (playback.active && currentRef.current.enabled && !currentRef.current.isBusy() && motion !== 'moving-left')
      pet.motion({ type: 'moving-left', loop: true })
  }

  function onError(error: unknown): void {
    if ((error instanceof Error || error instanceof DOMException) && error.name === 'AbortError')
      return
    if (playback.active && playback.animation)
      setFailed(previous => previous.includes(playback.animation!) ? previous : [...previous, playback.animation!])
    reportPetIssue('asset', error)
  }

  return { ...playback, config: source?.kind === 'dsh' ? playback.config : null, frame: currentFrame, onMotionChange, onError }
}
