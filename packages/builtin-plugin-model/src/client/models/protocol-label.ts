import type { ModelsKey } from './locales.ts'

const PROTOCOL_LABEL_KEYS: Readonly<Record<string, ModelsKey>> = {
  'openai-completions': 'protocolOpenAiCompletions',
  'openai-responses': 'protocolOpenAiResponses',
  'anthropic-messages': 'protocolAnthropicMessages',
}

export function protocolLabel(t: (key: ModelsKey) => string, protocol: string): string {
  const key = PROTOCOL_LABEL_KEYS[protocol]
  return key === undefined ? protocol : t(key)
}
