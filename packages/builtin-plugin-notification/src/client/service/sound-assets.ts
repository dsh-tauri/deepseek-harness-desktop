import type { BuiltinNotificationSound } from '../types'
import classicSound from '../../../assets/classic.wav'
import defaultSound from '../../../assets/notification.wav'

const assets: Record<BuiltinNotificationSound, string> = {
  default: defaultSound,
  classic: classicSound,
}

export function builtinSound(sound: BuiltinNotificationSound): string {
  return assets[sound]
}
