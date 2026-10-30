import type { CNode } from 'css-render'
import { PLUGIN_ID } from '../../shared/constants'

const OWNER_ATTRIBUTE = 'data-plugin'

const mountCounts = new Map<CNode, number>()

function existingElement(id?: string): HTMLStyleElement | null {
  return id === undefined ? null : document.querySelector<HTMLStyleElement>(`style[cssr-id="${id}"]`)
}

export function mountStyle(cnode: CNode, id?: string, owner: string = PLUGIN_ID): () => void {
  const release = (): void => {
    const next = (mountCounts.get(cnode) ?? 1) - 1
    if (next <= 0) {
      mountCounts.delete(cnode)
      cnode.unmount({ id })
    }
    else {
      mountCounts.set(cnode, next)
    }
  }
  if (typeof document === 'undefined')
    return () => {}
  const count = mountCounts.get(cnode) ?? 0
  const existing = existingElement(id)
  if (count === 0 || (id !== undefined && existing === null)) {
    existing?.remove()
    cnode.mount({ id, head: true }).setAttribute(OWNER_ATTRIBUTE, owner)
  }
  mountCounts.set(cnode, count + 1)
  return release
}
