import type { EventHandlerRequest } from 'dsh-tauri'
import type { EndpointModelsResponse, GetEndpointModelsQuery } from '../../index.types'
import { defineEventHandler, getQuery } from 'dsh-tauri'
import { endpointModels } from '../../../service/endpoint-models'

export default defineEventHandler<EventHandlerRequest, Promise<EndpointModelsResponse>>(async (event) => {
  const query = getQuery<GetEndpointModelsQuery>(event)
  const result = await endpointModels.list({
    ns: typeof query.ns === 'string' ? query.ns : '',
    profilePath: typeof query.profilePath === 'string' ? query.profilePath : undefined,
    baseURL: typeof query.baseURL === 'string' ? query.baseURL : undefined,
    apiKey: typeof query.apiKey === 'string' ? query.apiKey : undefined,
    headers: typeof query.headers === 'string' ? query.headers : undefined,
  })
  if (!result.ok) {
    event.res.status = 502
    return { ok: false, error: result.error }
  }
  return { ok: true, url: result.url, models: result.models }
})
