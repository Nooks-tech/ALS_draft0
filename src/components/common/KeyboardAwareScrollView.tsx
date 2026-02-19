import React, { ReactNode } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleProp,
  ViewStyle,
} from 'react-native';

type Props = {
  children: ReactNode;
  className?: string;
  contentContainerStyle?: StyleProp<ViewStyle>;
  keyboardVerticalOffset?: number;
};

/**
 * Wraps ScrollView with KeyboardAvoidingView so focused inputs stay visible
 * when the keyboard opens. Use in modals and forms.
 */
export function KeyboardAwareScrollView({
  children,
  className,
  contentContainerStyle,
  keyboardVerticalOffset = 0,
}: Props) {
  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={{ flex: 1 }}
      keyboardVerticalOffset={keyboardVerticalOffset}
    >
      <ScrollView
        className={className}
        contentContainerStyle={contentContainerStyle}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        {children}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
