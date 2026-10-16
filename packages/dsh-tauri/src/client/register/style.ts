import type { ClientContext } from '../types'
import { defineRegister } from '.'
import { invokeParent } from '../service/invoke-parent'
import { getFrameStyle, getOverlayMarkedStyle, getSidebarStyle, STYLE_INPUT_SELECTOR } from './style.utils'

export const registerStyle = defineRegister<ClientContext>((controller) => {
  let pendingFrame: number | undefined
  let previous: string | undefined
  let inputs: Element[] = []

  function reportSidebarBackground() {
    pendingFrame = undefined
    inputs = [...document.querySelectorAll(STYLE_INPUT_SELECTOR)]
    const message = {
      type: 'dsh://style',
      sidebar: getSidebarStyle(),
      marked: getOverlayMarkedStyle(),
      frame: getFrameStyle(),
      colorScheme: document.documentElement.style.colorScheme,
    } as const
    const serialized = JSON.stringify(message)
    if (serialized === previous)
      return
    if (invokeParent(message).ok)
      previous = serialized
  }

  function scheduleReport() {
    if (pendingFrame === undefined)
      pendingFrame = requestAnimationFrame(reportSidebarBackground)
  }

  function affectsStyle(record: MutationRecord) {
    const target = record.target
    if (record.type === 'characterData')
      return target.parentElement?.matches('style') === true
    if (inputs.some(input => target.contains(input)))
      return true
    if (target instanceof Element && target.matches(STYLE_INPUT_SELECTOR))
      return true
    if (record.type === 'attributes') {
      if (target === document.documentElement || target === document.body)
        return true
      if (record.attributeName === 'class')
        return /(?:^|\s)_mask_|_frame$/.test(record.oldValue ?? '')
      return record.attributeName === 'data-slot' && record.oldValue === 'sidebar'
    }
    return [...record.addedNodes, ...record.removedNodes].some(node =>
      node instanceof Element && (node.matches(STYLE_INPUT_SELECTOR) || node.querySelector(STYLE_INPUT_SELECTOR) !== null),
    )
  }

  // keep:effect 合并相关 DOM 更新的样式读取，并由 controller 回收尚未执行的帧。
  controller.add(() => {
    if (pendingFrame !== undefined)
      cancelAnimationFrame(pendingFrame)
  })
  controller.observe(document.documentElement, (records) => {
    if (pendingFrame === undefined && records.some(affectsStyle))
      scheduleReport()
  }, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeOldValue: true,
    attributeFilter: ['style', 'class', 'data-theme', 'data-slot', 'href', 'rel', 'media', 'disabled'],
  })
  controller.listen('load', (event) => {
    if (event.target instanceof HTMLLinkElement && event.target.matches(STYLE_INPUT_SELECTOR))
      scheduleReport()
  }, { capture: true })
  controller.listenWindow('resize', scheduleReport)
  scheduleReport()
})
