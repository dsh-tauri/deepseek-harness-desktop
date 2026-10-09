import type { ArchivedListPayload } from '../../../../service/ledger.types'
import { defineEventHandler } from 'h3'
import { ledger } from '../../../../service/ledger'

export default defineEventHandler((): ArchivedListPayload => ledger.load())
