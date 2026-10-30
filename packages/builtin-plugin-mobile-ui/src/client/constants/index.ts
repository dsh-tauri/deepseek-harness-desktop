import { MOBILE_POINTER_QUERIES } from 'dsh-tauri/client'

export const MOBILE_SETTINGS_MEDIA = `${MOBILE_POINTER_QUERIES.join(' and ')} and (max-width: 767px)`
