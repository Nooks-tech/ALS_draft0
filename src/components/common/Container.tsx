import { Platform, SafeAreaView, StatusBar, View } from 'react-native';

interface ContainerProps {
  children: React.ReactNode;
  className?: string;
}

export const Container = ({ children, className }: ContainerProps) => {
  return (
    <SafeAreaView 
      style={{ 
        flex: 1, 
        paddingTop: Platform.OS === "android" ? StatusBar.currentHeight : 0 
      }} 
      className={`bg-white flex-1 ${className}`}
    >
      <View className="flex-1 px-4">
        {children}
      </View>
    </SafeAreaView>
  );
};