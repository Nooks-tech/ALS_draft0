import React, { Component, ErrorInfo, ReactNode } from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import i18n from '../../i18n';

type Props = { children: ReactNode; fallback?: ReactNode };
type State = { hasError: boolean; error?: Error };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('[ErrorBoundary]', error, errorInfo.componentStack);
  }

  retry = () => this.setState({ hasError: false, error: undefined });

  render() {
    if (this.state.hasError && this.state.error) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <View className="flex-1 bg-slate-50 justify-center items-center px-6">
          <Text className="text-slate-800 font-bold text-lg text-center">{i18n.t('error_something_wrong')}</Text>
          <Text className="text-slate-500 text-sm text-center mt-2">
            {this.state.error.message}
          </Text>
          <TouchableOpacity
            onPress={this.retry}
            className="mt-6 bg-[#0D9488] px-6 py-3 rounded-xl"
          >
            <Text className="text-white font-bold">{i18n.t('try_again')}</Text>
          </TouchableOpacity>
        </View>
      );
    }
    return this.props.children;
  }
}
