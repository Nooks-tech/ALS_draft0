import { Text, TextInput, TextInputProps, View } from 'react-native';

interface InputProps extends TextInputProps {
  label: string;
  error?: string;
}

export const Input = ({ label, error, ...props }: InputProps) => {
  return (
    <View className="mb-4">
      <Text className="text-gray-700 mb-2 font-medium text-start">{label}</Text>
      <TextInput
        className={`w-full h-12 border rounded-xl px-4 bg-gray-50 text-start ${
          error ? 'border-red-500' : 'border-gray-200'
        }`}
        placeholderTextColor="#9CA3AF"
        {...props}
      />
      {error && <Text className="text-red-500 text-xs mt-1 text-start">{error}</Text>}
    </View>
  );
};