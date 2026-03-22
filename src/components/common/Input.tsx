import { I18nManager, Text, TextInput, TextInputProps, View } from 'react-native';

interface InputProps extends TextInputProps {
  label: string;
  error?: string;
}

export const Input = ({ label, error, style, ...props }: InputProps) => {
  const textAlign = I18nManager.isRTL ? 'right' : 'left';

  return (
    <View className="mb-4">
      <Text className="text-gray-700 mb-2 font-medium" style={{ textAlign }}>{label}</Text>
      <TextInput
        className={`w-full h-12 border rounded-xl px-4 bg-gray-50 text-start ${
          error ? 'border-red-500' : 'border-gray-200'
        }`}
        placeholderTextColor="#64748b"
        style={[
          {
            textAlign,
            writingDirection: I18nManager.isRTL ? 'rtl' : 'ltr',
          },
          style,
        ]}
        {...props}
      />
      {error && <Text className="text-red-500 text-xs mt-1" style={{ textAlign }}>{error}</Text>}
    </View>
  );
};