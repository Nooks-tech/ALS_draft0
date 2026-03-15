import ExpoPasskit from './src/ExpoPasskit';

export function canAddPasses(): boolean {
  return ExpoPasskit.canAddPasses();
}

export async function addPass(base64: string): Promise<boolean> {
  return await ExpoPasskit.addPass(base64);
}
