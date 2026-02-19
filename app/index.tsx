import { Redirect } from 'expo-router';
import Constants from 'expo-constants';
import { useAuth } from '../src/context/AuthContext';

/** Set EXPO_PUBLIC_SKIP_AUTH_FOR_DEV=true in .env only for local dev. Production: leave unset or false. */
const SKIP_AUTH_FOR_DEV =
  Constants.expoConfig?.extra?.skipAuthForDev === true ||
  process.env.EXPO_PUBLIC_SKIP_AUTH_FOR_DEV === 'true';

export default function Index() {
  const { user, loading, initialized } = useAuth();

  if (!initialized || loading) return null;

  if (SKIP_AUTH_FOR_DEV) {
    return <Redirect href="/(tabs)/menu" />;
  }

  return <Redirect href={user ? "/(tabs)/menu" : "/(auth)/login"} />;
}