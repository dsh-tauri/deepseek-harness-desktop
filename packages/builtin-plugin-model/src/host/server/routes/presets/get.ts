import type { EventHandlerRequest } from 'h3'
import type { GetPresetsQuery, PresetsResponse } from '../index.types'
import { defineEventHandler, getQuery } from 'h3'
import { modelPresets } from '../../../service/model-presets'

export default defineEventHandler<EventHandlerRequest, Promise<PresetsResponse>>(async (event) => {
  const query = getQuery<GetPresetsQuery>(event)
  const result = await modelPresets.resolve(query.force === 'true')
  if (!result.ok) {
    event.res.status = 502
    return { ok: false, error: result.error }
  }
  return {
    ok: true,
    source: result.source,
    fetchedAt: result.fetchedAt,
    stale: result.stale,
    count: Object.keys(result.presets).length,
    presets: result.presets,
  }
})
