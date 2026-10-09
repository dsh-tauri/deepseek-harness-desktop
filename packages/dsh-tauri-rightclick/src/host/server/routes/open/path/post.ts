import type { EventHandlerRequest } from 'h3'
import type { OperationResult } from '../../../../types'
import type { OpenPathBody } from '../../index.types'
import { defineEventHandler, readBody } from 'h3'
import { isEmpty, isString, trim } from 'lodash-es'
import { JSON_CONTENT_TYPE } from '../../../../config/constants'
import { opener } from '../../../../service/opener'

/** 带 URL scheme 的值不是本地路径（外链走 open/url）。 */
const URL_SCHEME_PATTERN = /^[a-z][a-z\d+.-]*:\/\//i

export default defineEventHandler<EventHandlerRequest, Promise<OperationResult>>(async (event) => {
  const contentType = event.req.headers.get('content-type') ?? ''
  if (!JSON_CONTENT_TYPE.test(contentType)) {
    event.res.status = 415
    return { ok: false as const, error: 'unsupported-media-type' }
  }

  const body = await readBody<OpenPathBody>(event, { type: 'json' })
  const raw = body?.path
  const path = isString(raw) ? trim(raw) : ''
  if (isEmpty(path) || URL_SCHEME_PATTERN.test(path)) {
    event.res.status = 400
    return { ok: false as const, error: 'invalid-path' }
  }

  const result = await opener.openDirectory(path)
  if (!result.ok)
    event.res.status = 400
  return result
})
