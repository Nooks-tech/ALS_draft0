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

const LOCATION_TIMEOUT_MS = 15_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
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
        setError('Location permission denied. Please enable location in your device settings.');
        return null;
      }

      let loc: Location.LocationObject;
      try {
        loc = await withTimeout(
          Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
          LOCATION_TIMEOUT_MS,
          'GPS fix',
        );
      } catch {
        loc = await withTimeout(
          Location.getLastKnownPositionAsync() as Promise<Location.LocationObject>,
          5_000,
          'Last known position',
        );
        if (!loc) {
          setError('Could not determine your location. Make sure GPS is enabled.');
          return null;
        }
      }

      const { latitude, longitude } = loc.coords;
      let addr = `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`;
      let city: string | undefined;
      try {
        const [rev] = await withTimeout(
          Location.reverseGeocodeAsync({ latitude, longitude }),
          5_000,
          'Reverse geocode',
        );
        if (rev) {
          addr = [rev.street, rev.district, rev.city, rev.region].filter(Boolean).join(', ') || addr;
          city = rev.city ?? undefined;
        }
      } catch {
        // Keep coordinate-based address as fallback
      }

      const result: DeliveryAddress = { address: addr, lat: latitude, lng: longitude, city };
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
