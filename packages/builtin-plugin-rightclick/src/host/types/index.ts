/** 宿主上下文：只消费已核实存在的成员，不把某一版内核类型钉进构建。 */
export type HostContext = any

export interface OperationResult {
  ok: boolean
  error?: string
}
