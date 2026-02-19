import { Copy } from 'lucide-react-native';
import { Clipboard, ImageBackground, Text, TouchableOpacity, View } from 'react-native';

interface OfferProps {
  title: string;
  description: string;
  code: string;
  image: string;
  expiry: string;
}

export const OfferCard = ({ title, description, code, image, expiry }: OfferProps) => {
  const copyToClipboard = () => {
    Clipboard.setString(code);
    alert(`Copied code: ${code}`);
  };

  return (
    <View className="mb-6 rounded-2xl overflow-hidden shadow-md bg-white">
      {/* 1. Image Background */}
      <ImageBackground 
        source={{ uri: image }} 
        className="h-40 justify-end p-4"
        imageStyle={{ borderRadius: 16 }}
      >
        <View className="absolute inset-0 bg-black/40 rounded-2xl" /> 
        <Text className="text-white font-bold text-2xl z-10">{title}</Text>
        <Text className="text-gray-200 text-sm z-10">{expiry}</Text>
      </ImageBackground>

      {/* 2. Content & Code */}
      <View className="p-4 flex-row justify-between items-center">
        <View className="flex-1 pr-4">
          <Text className="text-gray-600 leading-5">{description}</Text>
        </View>

        <TouchableOpacity 
          onPress={copyToClipboard}
          className="bg-red-50 px-4 py-2 rounded-lg border border-red-100 border-dashed flex-row items-center"
        >
          <Text className="text-[#00854e] font-bold mr-2 tracking-wider">{code}</Text>
          <Copy size={16} color="#FF5A5F" />
        </TouchableOpacity>
      </View>
    </View>
  );
};