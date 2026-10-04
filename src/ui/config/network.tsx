import { Button, Description, Input, Label } from '@heroui/react'
import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from 'valtio-define'
import { Panel } from '@/components/panel'
import { store } from '@/store'
import { toast } from '@/utils/toast'

export function ConfigNetwork() {
  const { t } = useTranslation()
  const { proxy_url: savedProxy } = useStore(store.setting)
  const [input, setInput] = useState<string>()
  const value = input ?? savedProxy
  const save = useMutation({
    mutationFn: async () => {
      const proxyUrl = value.trim()
      if (proxyUrl) {
        let url: URL
        try {
          url = new URL(proxyUrl)
        }
        catch {
          throw new Error('PROXY_INVALID')
        }
        if (!proxyUrl.includes('://') || /\s/.test(proxyUrl)
          || !['http:', 'https:', 'socks5:', 'socks5h:'].includes(url.protocol)
          || !url.hostname || url.port === '0' || !['', '/'].includes(url.pathname)
          || url.search || url.hash) {
          throw new Error('PROXY_INVALID')
        }
      }
      await store.setting.update({ proxyUrl })
    },
    onSuccess: () => {
      setInput(undefined)
      toast(t('network.saved'))
    },
    onError: (error: unknown) => {
      toast(t(String(error).includes('PROXY_INVALID') ? 'network.invalid' : 'network.save_failed'), { variant: 'danger' })
    },
  })

  return (
    <div className="space-y-4">
      <Panel.Header title={t('config.network')} testId="dsh-config-panel-title" />
      <div className="space-y-2">
        <Label htmlFor="dsh-proxy-url">{t('network.proxy_url')}</Label>
        <Input
          id="dsh-proxy-url"
          data-testid="dsh-proxy-url"
          aria-describedby="dsh-proxy-description"
          type="password"
          autoComplete="off"
          spellCheck={false}
          variant="secondary"
          placeholder="http://127.0.0.1:7897"
          value={value}
          disabled={save.isPending}
          onChange={event => setInput(event.target.value)}
        />
        <Description id="dsh-proxy-description">{t('network.description')}</Description>
        <Description>{t('network.formats')}</Description>
      </div>
      <Button
        data-testid="dsh-proxy-save"
        variant="primary"
        isPending={save.isPending}
        isDisabled={save.isPending || value === savedProxy}
        onPress={() => save.mutate()}
      >
        {t('buttons.save')}
      </Button>
    </div>
  )
}
