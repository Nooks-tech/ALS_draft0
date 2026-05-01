import { Platform, SafeAreaView, StatusBar, View } from 'react-native';

interface ContainerProps {
  children: React.ReactNode;
  className?: string;
  /** When set, overrides default white background (e.g. merchant branding). */
  backgroundColor?: string;
}

export const Container = ({ children, className, backgroundColor }: ContainerProps) => {
  return (
    <SafeAreaView 
      style={{ 
        flex: 1, 
        paddingTop: Platform.OS === "android" ? StatusBar.currentHeight : 0,
        backgroundColor: backgroundColor ?? '#ffffff' }} 
      className={`flex-1 ${className ?? ''}`}
    >
      <View className="flex-1 px-4">
        {children}
      </View>
    </SafeAreaView>
  );
};