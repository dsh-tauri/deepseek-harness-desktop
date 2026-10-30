export function parseJsonResponse(text: string): unknown {
  if (text.length === 0)
    return undefined
  try {
    return JSON.parse(text)
  }
  catch {
    return text
  }
}

export function defaultErrorMessage(status: number, body: unknown): string {
  const text = typeof body === 'string'
    ? body
    : body && typeof body === 'object'
      ? readErrorText(body as Record<string, unknown>)
      : ''
  return text ? `请求失败 (${status}): ${text}` : `请求失败 (${status})`
}

function readErrorText(body: Record<string, unknown>): string {
  for (const key of ['error', 'message', 'statusMessage'] as const) {
    const value = body[key]
    if (typeof value === 'string' && value.length > 0)
      return value
  }
  return ''
}
