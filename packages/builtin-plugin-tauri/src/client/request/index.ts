import type { FetchOptions as OfetchOptions } from 'ofetch'
import { createFetch } from 'ofetch'
import { defaultErrorMessage, parseJsonResponse } from './index.utils'

export type FetchOptions = OfetchOptions<'json'>

export const fetch = createFetch({
  defaults: {
    retry: 0,
    parseResponse: parseJsonResponse,
    onResponseError: ({ response }) => {
      throw Object.assign(new Error(defaultErrorMessage(response.status, response._data)), { status: response.status })
    },
  },
})

export const ofetch = fetch
