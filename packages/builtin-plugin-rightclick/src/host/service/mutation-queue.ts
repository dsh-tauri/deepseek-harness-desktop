import { defineService } from 'dsh-tauri'

/** 队列尾指针：每个新变更都接在上一次落定之后（成功失败都继续，不卡死后续）。 */
let tail: Promise<unknown> = Promise.resolve()

/**
 * 宿主变更串行队列：开链与开目录都会拉起系统进程，串行执行避免一次交互里并发拉起多个
 * OS 打开操作。前一次失败不阻塞后一次。
 */
export const mutationQueue = defineService({
  start<T>(operation: () => Promise<T>): Promise<T> {
    const result = tail.then(operation, operation)
    tail = result.then(() => undefined, () => undefined)
    return result
  },
})
