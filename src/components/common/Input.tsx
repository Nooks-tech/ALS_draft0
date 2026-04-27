import { Text, TextInput, TextInputProps, View } from 'react-native';
import { useTranslation } from 'react-i18next';

interface InputProps extends TextInputProps {
  label: string;
  error?: string;
}

export const Input = ({ label, error, style, ...props }: InputProps) => {
  const { i18n } = useTranslation();
  const isArabic = i18n.language === 'ar';
  const textAlign = isArabic ? 'right' : 'left';

  return (
    <View className="mb-4">
      <Text className="text-gray-700 mb-2 font-medium" style={{ textAlign }}>{label}</Text>
      <TextInput
        className={`w-full h-12 border rounded-xl px-4 bg-gray-50 ${
          error ? 'border-red-500' : 'border-gray-200'
        }`}
        placeholderTextColor="#64748b"
        style={[
          {
            textAlign,
            writingDirection: isArabic ? 'rtl' : 'ltr',
          },
          style,
        ]}
        {...props}
      />
      {error && <Text className="text-red-500 text-xs mt-1" style={{ textAlign }}>{error}</Text>}
    </View>
  );
};