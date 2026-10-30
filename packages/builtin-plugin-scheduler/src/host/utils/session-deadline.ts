const SESSION_OPERATION_TIMEOUT_MS = 10_000

export class SessionOperationTimeout extends Error {
  constructor() {
    super('等待宿主会话操作超时')
  }
}

export async function withSessionDeadline<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new SessionOperationTimeout()), SESSION_OPERATION_TIMEOUT_MS)
      }),
    ])
  }
  finally {
    clearTimeout(timer)
  }
}
