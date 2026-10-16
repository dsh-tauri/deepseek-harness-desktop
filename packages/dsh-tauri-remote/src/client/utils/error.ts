import type { RemoteKey } from '../locales/index'
import { isTransportError } from '../apis/parsers'

export function errorTextOf(message: string, t: (key: RemoteKey) => string): string {
  return isTransportError(message) ? t('error.unavailable') : message
}
