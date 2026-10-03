import { useEffect } from 'react'
import { View } from 'react-native'
import Animated, { cancelAnimation, useAnimatedStyle, useSharedValue, withDelay, withRepeat, withSequence, withTiming } from 'react-native-reanimated'

function Pulse({ delay }: { delay: number }) {
  const pulse = useSharedValue(0)
  // keep:effect Start and cancel the native loading animation for this dot.
  useEffect(() => {
    pulse.value = withDelay(delay, withRepeat(withSequence(withTiming(1, { duration: 450 }), withTiming(0, { duration: 450 })), -1))
    return () => cancelAnimation(pulse)
  }, [delay, pulse])
  const style = useAnimatedStyle(() => ({
    opacity: 0.25 + pulse.value * 0.75,
    transform: [{ translateY: -pulse.value * 5 }],
  }))
  return <Animated.View className="h-2 w-2 rounded-full bg-foreground" style={style} />
}

export function BreathingLight() {
  return (
    <View className="h-6 flex-row items-center justify-center gap-2.5" accessible accessibilityRole="progressbar">
      <Pulse delay={0} />
      <Pulse delay={150} />
      <Pulse delay={300} />
    </View>
  )
}
