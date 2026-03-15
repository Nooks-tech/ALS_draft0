import { requireNativeModule } from 'expo-modules-core';

interface ExpoPasskitInterface {
  canAddPasses(): boolean;
  addPass(base64: string): Promise<boolean>;
}

export default requireNativeModule<ExpoPasskitInterface>('ExpoPasskit');
