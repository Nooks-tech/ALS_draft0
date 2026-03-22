/**
 * Remote merchant logos with settings tuned to avoid soft/pixelated look:
 * - expo-image (better sampling than RN Image on many devices)
 * - allowDownscaling=false keeps full decoded resolution before GPU scale
 * - high cache priority for header / auth
 */
import { Image, type ImageProps } from 'expo-image';
import { type StyleProp, type ViewStyle } from 'react-native';

type Props = Omit<ImageProps, 'source'> & {
  uri: string;
  /** Width/height in dp (square). */
  sizeDp: number;
  /** Optional transform scale (e.g. in-app logo scale). */
  scaleFactor?: number;
  style?: StyleProp<ViewStyle>;
};

export function MerchantLogoImage({ uri, sizeDp, scaleFactor = 1, style, ...rest }: Props) {
  return (
    <Image
      source={{ uri }}
      style={[{ width: sizeDp, height: sizeDp, transform: [{ scale: scaleFactor }] }, style]}
      contentFit="contain"
      cachePolicy="memory-disk"
      priority="high"
      allowDownscaling={false}
      {...rest}
    />
  );
}
