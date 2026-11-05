// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { isSubmitTrigger } from './mode-select.utils'

/** 核心 0.2.2-rc.1 `ui-conversation` 字典：发送 / 发送中 / 停止 / 排队 / 插话。 */
const CONVERSATION: Readonly<Record<string, readonly [string, string, string, string, string]>> = {
  zh: ['发送消息', '正在发送消息', '停止生成', '排队发送', '插话发送'],
  en: ['Send message', 'Sending message', 'Stop generating', 'Queue message', 'Steer message'],
  ja: ['メッセージを送信', 'メッセージを送信中', '生成を停止', 'メッセージをキューに追加', '実行中の指示にメッセージを追加'],
  es: ['Enviar mensaje', 'Enviando mensaje', 'Detener generación', 'mensaje de cola', 'Redirigir mensaje'],
  fr: ['Envoyer le message', 'Envoi du message', 'Arrêter la génération', 'Message de file d\'attente', 'Guider avec ce message'],
  de: ['Nachricht senden', 'Nachricht wird gesendet', 'Generierung stoppen', 'Warteschlangennachricht', 'Mit Nachricht lenken'],
  ru: ['Отправить сообщение', 'Отправка сообщения', 'Остановить генерацию', 'Сообщение в очереди', 'Направить сообщение'],
  pt: ['Enviar mensagem', 'Enviando mensagem', 'Parar geração', 'Mensagem de fila', 'Orientar com mensagem'],
}

function button(label: string): HTMLButtonElement {
  const element = document.createElement('button')
  element.setAttribute('aria-label', label)
  document.body.append(element)
  return element
}

function dispatch(target: Element): MouseEvent {
  const event = new MouseEvent('click', { bubbles: true })
  target.dispatchEvent(event)
  return event
}

function enter(options: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent('keydown', { key: 'Enter', ...options })
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('isSubmitTrigger', () => {
  it.each(Object.entries(CONVERSATION))('把 %s 的官方发送按钮点击识别为提交', (_language, [send]) => {
    expect(isSubmitTrigger(dispatch(button(send)), () => send)).toBe(true)
  })

  it.each(Object.entries(CONVERSATION))('不把 %s 的发送中、停止、排队与插话按钮识别为提交', (_language, [send, sending, stop, queue, steer]) => {
    for (const label of [sending, stop, queue, steer])
      expect(isSubmitTrigger(dispatch(button(label)), () => send)).toBe(false)
  })

  it('点击按钮内图标时按所属按钮的 aria-label 判定', () => {
    const send = CONVERSATION.zh![0]
    const icon = document.createElement('span')
    button(send).append(icon)
    expect(isSubmitTrigger(dispatch(icon), () => send)).toBe(true)
  })

  it('点击没有 aria-label 的按钮或空白处不提交', () => {
    const send = CONVERSATION.zh![0]
    const bare = document.createElement('button')
    document.body.append(bare)
    expect(isSubmitTrigger(dispatch(bare), () => send)).toBe(false)
    expect(isSubmitTrigger(dispatch(document.body), () => send)).toBe(false)
  })

  it('编辑区 Enter 提交，Shift+Enter 与组合输入中的 Enter 不提交', () => {
    const send = CONVERSATION.zh![0]
    expect(isSubmitTrigger(enter(), () => send)).toBe(true)
    expect(isSubmitTrigger(enter({ shiftKey: true }), () => send)).toBe(false)
    expect(isSubmitTrigger(enter({ isComposing: true }), () => send)).toBe(false)
  })
})
