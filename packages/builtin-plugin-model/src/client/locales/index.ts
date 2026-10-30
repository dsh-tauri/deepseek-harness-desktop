import { defineLocale } from 'dsh-tauri/client'
import { PLUGIN_ID } from '../../shared/constants'
import { en, zh } from '../models/locales'

export const locale = defineLocale(PLUGIN_ID, { zh, en })
