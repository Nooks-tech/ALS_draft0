import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { ReactNode } from 'react';
import { View } from 'react-native';

type Props = {
  children: ReactNode;
  onDismiss: () => void;
  height?: number | string;
  style?: object;
};

const SPRING_CONFIG = { damping: 20, stiffness: 300 };
const DISMISS_THRESHOLD = 200;
const DISMISS_VELOCITY = 900;

export function SwipeableBottomSheet({ children, onDismiss, height, style }: Props) {
  const translateY = useSharedValue(0);

  const pan = Gesture.Pan()
    .activeOffsetY(15)
    .failOffsetY(-15)
    .onUpdate((e) => {
      if (e.translationY > 0) {
        translateY.value = e.translationY;
      }
    })
    .onEnd((e) => {
      if (e.translationY > DISMISS_THRESHOLD || e.velocityY > DISMISS_VELOCITY) {
        runOnJS(onDismiss)();
      } else {
        translateY.value = withSpring(0, SPRING_CONFIG);
      }
    });

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
  }));

  return (
    <GestureDetector gesture={pan}>
      <Animated.View
        style={[
          height ? { height } : {},
          style,
          animatedStyle,
        ]}
      >
        <View className="items-center py-2">
          <View className="w-10 h-1 rounded-full bg-slate-300" />
        </View>
        {children}
      </Animated.View>
    </GestureDetector>
  );
}
