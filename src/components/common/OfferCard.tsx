import * as ExpoClipboard from 'expo-clipboard';
import { Copy } from 'lucide-react-native';
import { Alert, ImageBackground, Text, TouchableOpacity, View } from 'react-native';
import { useMerchantBranding } from '../../context/MerchantBrandingContext';

interface OfferProps {
  title: string;
  description: string;
  code: string;
  image: string;
  expiry: string;
}

export const OfferCard = ({ title, description, code, image, expiry }: OfferProps) => {
  const { primaryColor } = useMerchantBranding();

  const copyToClipboard = async () => {
    await ExpoClipboard.setStringAsync(code);
    Alert.alert('Copied', `Code "${code}" copied to clipboard`);
  };

  return (
    <View className="mb-6 rounded-2xl overflow-hidden shadow-md bg-white">
      <ImageBackground 
        source={{ uri: image }} 
        className="h-40 justify-end p-4"
        imageStyle={{ borderRadius: 16 }}
      >
        <View className="absolute inset-0 bg-black/40 rounded-2xl" /> 
        <Text className="text-white font-bold text-2xl z-10">{title}</Text>
        <Text className="text-gray-200 text-sm z-10">{expiry}</Text>
      </ImageBackground>

      <View className="p-4 flex-row justify-between items-center">
        <View className="flex-1 pr-4">
          <Text className="text-gray-600 leading-5">{description}</Text>
        </View>

        <TouchableOpacity 
          onPress={copyToClipboard}
          className="px-4 py-2 rounded-lg border border-dashed flex-row items-center"
          style={{ backgroundColor: `${primaryColor}10`, borderColor: `${primaryColor}40` }}
        >
          <Text className="font-bold mr-2 tracking-wider" style={{ color: primaryColor }}>{code}</Text>
          <Copy size={16} color={primaryColor} />
        </TouchableOpacity>
      </View>
    </View>
  );
};