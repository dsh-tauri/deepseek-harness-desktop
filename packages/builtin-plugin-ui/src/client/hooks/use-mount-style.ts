import type { CNode } from 'css-render'
import { useEffect } from 'react'
import { mountStyle } from '../utils/style'

export function useMountStyle(cnode: CNode, id?: string, owner?: string): void {
  // keep:effect cssr 挂载是外部资源，随 React 生命周期释放。
  useEffect(() => mountStyle(cnode, id, owner), [cnode, id, owner])
}
