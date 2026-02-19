/**
 * Mapbox address search - debounced autocomplete
 */
import { useCallback, useEffect, useState } from 'react';
import { searchAddresses, MapboxSearchResult } from '../api/mapbox';

export function useMapboxSearch(query: string, debounceMs = 300) {
  const [results, setResults] = useState<MapboxSearchResult[]>([]);
  const [loading, setLoading] = useState(false);

  const search = useCallback(async (q: string) => {
    if (!q || q.trim().length < 3) {
      setResults([]);
      return;
    }
    setLoading(true);
    try {
      const res = await searchAddresses(q);
      setResults(res);
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => search(query), debounceMs);
    return () => clearTimeout(timer);
  }, [query, debounceMs, search]);

  return { results, loading };
}
