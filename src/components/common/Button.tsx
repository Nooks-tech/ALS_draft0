import { useRef } from 'react';
import { ActivityIndicator, Animated, Text, TouchableOpacity } from 'react-native';
import { useMerchantBranding } from '../../context/MerchantBrandingContext';

interface ButtonProps {
  title: string;
  onPress: () => void;
  variant?: 'primary' | 'outline' | 'danger';
  isLoading?: boolean;
  className?: string;
}

export const Button = ({
  title,
  onPress,
  variant = 'primary',
  isLoading = false,
  className
}: ButtonProps) => {
  const { primaryColor } = useMerchantBranding();
  const scaleValue = useRef(new Animated.Value(1)).current;

  const handlePressIn = () => {
    Animated.spring(scaleValue, {
      toValue: 0.95,
      useNativeDriver: true,
    }).start();
  };

  const handlePressOut = () => {
    Animated.spring(scaleValue, {
      toValue: 1,
      friction: 3,
      tension: 40,
      useNativeDriver: true,
    }).start();
  };

  const baseStyle = 'h-14 rounded-2xl flex-row justify-center items-center px-6 shadow-sm';
  const isPrimary = variant === 'primary';
  const isOutline = variant === 'outline';
  const isDanger = variant === 'danger';

  return (
    <Animated.View style={{ transform: [{ scale: scaleValue }] }}>
      <TouchableOpacity
        onPress={onPress}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        activeOpacity={0.9}
        disabled={isLoading}
        style={
          isPrimary ? { backgroundColor: primaryColor } : isOutline ? { borderWidth: 2, borderColor: primaryColor, backgroundColor: 'transparent' } : undefined
        }
        className={`${baseStyle} ${isDanger ? 'bg-red-600' : ''} ${className ?? ''} ${isLoading ? 'opacity-70' : ''}`}
      >
        {isLoading ? (
          <ActivityIndicator color={isOutline ? primaryColor : 'white'} />
        ) : (
          <Text
            className={`font-bold text-lg font-[Poppins-Bold] ${isDanger || isPrimary ? 'text-white' : ''}`}
            style={isOutline ? { color: primaryColor } : undefined}
          >
            {title}
          </Text>
        )}
      </TouchableOpacity>
    </Animated.View>
  );
};