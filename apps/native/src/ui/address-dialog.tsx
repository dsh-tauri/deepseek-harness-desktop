import { Button } from 'heroui-native/button'
import { Dialog } from 'heroui-native/dialog'
import { Input } from 'heroui-native/input'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { If, Then } from 'react-if-lite'
import { Text, View } from 'react-native'
import { parseAddressInput } from '@/utils/bridge-protocol'

/** 手动输入连接地址的对话框：扫码到不了的公网隧道/自建地址从这里进。 */
export function AddressDialog({ isOpen, initialValue = '', title, onClose, onSubmit }: {
  isOpen: boolean
  initialValue?: string
  title?: string
  onClose: () => void
  onSubmit: (url: string) => void
}) {
  const { t } = useTranslation()
  const [value, setValue] = useState(initialValue)
  const [invalid, setInvalid] = useState(false)
  const { address, invalid: parsedInvalid } = parseAddressInput(value)
  const canSubmit = address !== null
  function submit() {
    if (!canSubmit) {
      setInvalid(parsedInvalid)
      return
    }
    onSubmit(address.url)
  }
  function change(text: string) {
    setValue(text)
    setInvalid(false)
  }
  return (
    <Dialog
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open)
          onClose()
      }}
    >
      <Dialog.Portal unstable_accessibilityContainerViewIsModal>
        <Dialog.Overlay />
        <Dialog.Content className="gap-5">
          <View className="gap-2">
            <Dialog.Title>{title ?? t('scan.addressTitle')}</Dialog.Title>
            <Text className="text-sm leading-6 text-muted">{t('scan.addressHint')}</Text>
          </View>
          <Input
            accessibilityLabel={t('scan.address')}
            value={value}
            onChangeText={change}
            isInvalid={invalid}
            autoFocus
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            returnKeyType="go"
            onSubmitEditing={submit}
          />
          <If cond={invalid && !canSubmit}>
            <Then><Text className="text-sm text-danger" accessibilityLiveRegion="polite">{t('scan.invalidAddress')}</Text></Then>
          </If>
          <View className="flex-row justify-end gap-3">
            <Button variant="ghost" onPress={onClose}>{t('common.cancel')}</Button>
            <Button isDisabled={!canSubmit} onPress={submit}>{t('scan.connect')}</Button>
          </View>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog>
  )
}
