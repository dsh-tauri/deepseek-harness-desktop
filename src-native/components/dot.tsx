import { View } from 'react-native'

export function Dot({ status }: { status: 'checking' | 'available' | 'unavailable' }) {
  let className = 'h-2.5 w-2.5 rounded-full bg-muted'
  if (status === 'available')
    className = 'h-2.5 w-2.5 rounded-full bg-success'
  if (status === 'unavailable')
    className = 'h-2.5 w-2.5 rounded-full bg-danger'
  return <View className={className} />
}
