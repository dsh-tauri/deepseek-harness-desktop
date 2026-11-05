import {
  CONVERSATION_SCROLL_SELECTOR,
  CONVERSATION_SELECTOR,
  DIALOG_SELECTOR,
  HERO_SELECTOR,
} from '../constants'

export function pasteInto(editable: HTMLElement, value: string): boolean {
  if (editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement)
    return replaceSelection(editable, value)
  editable.focus()
  const before = editable.textContent ?? ''
  // 合成 paste 事件不带默认行为，须由编辑器自身管线接管并 preventDefault + 写入。
  const dataTransfer = new DataTransfer()
  dataTransfer.setData('text/plain', value)
  const event = new ClipboardEvent('paste', {
    bubbles: true,
    cancelable: true,
    clipboardData: dataTransfer,
  })
  editable.dispatchEvent(event)
  // 接收方已接管：ProseMirror 系编辑器异步更新 DOM，同步 textContent 仍是旧值，
  // 若只看内容变化会误判“没插入”而触发兜底，导致右键粘贴重复插入两次。
  if (event.defaultPrevented)
    return true
  if ((editable.textContent ?? '') !== before)
    return true
  if (document.execCommand('insertText', false, value))
    return true
  return replaceSelection(editable, value)
}

/** 替换可编辑元素中的当前选区（输入/文本域/可编辑区三态）；选区不可知时返回 false。 */
export function replaceSelection(editable: HTMLElement, value: string): boolean {
  editable.focus()
  if (editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement) {
    const start = editable.selectionStart ?? editable.value.length
    const end = editable.selectionEnd ?? start
    editable.setRangeText(value, start, end, 'end')
    editable.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }))
    return true
  }
  const selection = globalThis.getSelection()
  if (!selection?.rangeCount || !editable.contains(selection.anchorNode))
    return false
  const range = selection.getRangeAt(0)
  range.deleteContents()
  const textNode = document.createTextNode(value)
  range.insertNode(textNode)
  range.setStartAfter(textNode)
  range.collapse(true)
  selection.removeAllRanges()
  selection.addRange(range)
  editable.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }))
  return true
}

export function selectSurface(surface: HTMLElement): void {
  const selection = globalThis.getSelection()
  if (!selection)
    return
  const range = document.createRange()
  range.selectNodeContents(surface)
  selection.removeAllRanges()
  selection.addRange(range)
}

export function selectAll(editable: HTMLElement): void {
  editable.focus()
  if (editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement)
    editable.select()
  else
    selectSurface(editable)
}

/** 全选的内容面：对话正文 / 设置弹窗 / hero 首屏。 */
export function selectionSurface(target: unknown): HTMLElement | null {
  if (target instanceof Element) {
    const conversation = target.closest<HTMLElement>(CONVERSATION_SELECTOR)
    if (conversation)
      return conversation
    const dialog = target.closest<HTMLElement>(DIALOG_SELECTOR)
    if (dialog)
      return dialog
    const hero = target.closest<HTMLElement>(HERO_SELECTOR)
    if (hero?.querySelector(CONVERSATION_SCROLL_SELECTOR))
      return hero
  }
  return null
}
