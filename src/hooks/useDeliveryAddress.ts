/**
 * Delivery address - uses device location and Google Maps (when configured)
 */
import * as Location from 'expo-location';
import { useCallback, useState } from 'react';

export interface DeliveryAddress {
  address: string;
  lat?: number;
  lng?: number;
  city?: string;
}

export function useDeliveryAddress() {
  const [address, setAddress] = useState<DeliveryAddress | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchCurrentLocation = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        setError('Location permission denied');
        return null;
      }
      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const { latitude, longitude } = loc.coords;
      const [rev] = await Location.reverseGeocodeAsync({ latitude, longitude });
      const addr = rev
        ? [rev.street, rev.district, rev.city, rev.region].filter(Boolean).join(', ') || `${latitude},${longitude}`
        : `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`;
      const result: DeliveryAddress = { address: addr, lat: latitude, lng: longitude, city: rev?.city };
      setAddress(result);
      return result;
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to get location';
      setError(msg);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const setManualAddress = useCallback((addr: string, coords?: { lat: number; lng: number }) => {
    setAddress({
      address: addr,
      lat: coords?.lat,
      lng: coords?.lng,
    });
  }, []);

  return { address, loading, error, fetchCurrentLocation, setManualAddress };
}
