import { defineEventHandler } from 'h3'
import { archive } from '../../../../../service/archive'

export default defineEventHandler(() => archive.deleteAll())
