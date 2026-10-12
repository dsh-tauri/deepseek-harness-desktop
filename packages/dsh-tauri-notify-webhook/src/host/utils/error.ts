/** 投递异常统一成可读错误码：超时单独成码，其余用原始 message。 */
export function deliveryErrorOf(error: unknown): string {
  if (error instanceof Error)
    return error.name === 'TimeoutError' ? 'NOTIFY_TIMEOUT' : error.message
  return String(error)
}
