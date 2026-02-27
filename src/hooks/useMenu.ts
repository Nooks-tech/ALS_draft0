/**
 * Fetches menu from Nooks (when URL set) / Foodics API with fallback to local data
 */
import { useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState } from 'react-native';
import { foodicsApi, MenuProduct } from '../api/foodics';
import { fetchNooksBranches } from '../api/nooksBranches';
import { BRANCHES, CATEGORIES, PRODUCTS } from '../data/menu';
import { useMerchant } from '../context/MerchantContext';

export type MenuItem = MenuProduct & { category: string };

const mapToMenuItem = (p: (typeof PRODUCTS)[0]): MenuItem => ({
  id: p.id,
  name: p.name,
  price: p.price,
  category: p.category,
  description: p.description,
  image: p.image,
  modifierGroups: (p.modifierGroups || []).map((g) => ({
    id: g.id,
    title: g.title,
    options: g.options.map((o) => ({ name: o.name, price: o.price || 0 })),
  })),
});

export function useMenu() {
  const { merchantId } = useMerchant();
  const [products, setProducts] = useState<MenuItem[]>(PRODUCTS.map(mapToMenuItem));
  const [categories, setCategories] = useState<string[]>(CATEGORIES.filter((c) => c !== 'All'));
  const [branches, setBranches] = useState(BRANCHES);
  // Start with local data immediately; refresh from APIs in background.
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<'local' | 'foodics' | 'nooks'>('local');

  useEffect(() => {
    let cancelled = false;
    const cacheKey = `@als_menu_${merchantId || 'default'}`;
    let nextProducts = products;
    let nextCategories = categories;
    let nextBranches = branches;
    let nextSource: 'local' | 'foodics' | 'nooks' = source;

    AsyncStorage.getItem(cacheKey).then((raw) => {
      if (!raw || cancelled) return;
      try {
        const cached = JSON.parse(raw) as {
          products?: MenuItem[];
          categories?: string[];
          branches?: typeof BRANCHES;
          source?: 'local' | 'foodics' | 'nooks';
        };
        if (cached.products?.length) {
          nextProducts = cached.products;
          setProducts(cached.products);
        }
        if (cached.categories?.length) {
          nextCategories = cached.categories;
          setCategories(cached.categories);
        }
        if (cached.branches?.length) {
          nextBranches = cached.branches;
          setBranches(cached.branches);
        }
        if (cached.source) {
          nextSource = cached.source;
          setSource(cached.source);
        }
      } catch {
        // Ignore invalid cache payload
      }
    });

    async function fetchMenu() {
      if (!cancelled) setLoading(true);
      try {
        // Branches: Nooks first (when API URL + merchant set), then Foodics, then local
        const nooksBranches = await fetchNooksBranches(merchantId);
        if (cancelled) return;
        if (nooksBranches.length > 0) {
          nextBranches = nooksBranches.map((b) => ({
            id: b.id,
            name: b.name,
            address: b.address ?? '',
            distance: b.distance,
          }));
          setBranches(nextBranches);
          setSource('nooks');
          nextSource = 'nooks';
        } else {
          const branchesData = await foodicsApi.getBranches();
          if (cancelled) return;
          if (branchesData?.length) {
            setBranches(branchesData);
            nextBranches = branchesData;
            setSource('foodics');
            nextSource = 'foodics';
          }
        }

        const data = await foodicsApi.getMenu();
        if (cancelled) return;
        if (data?.products?.length) {
          nextProducts = data.products.map((p) => ({
            ...p,
            category: p.category || 'Menu',
          }));
          setProducts(nextProducts);
          if (data.categories?.length) {
            nextCategories = ['All', ...data.categories];
            setCategories(nextCategories);
          }
          if (nextSource === 'local') {
            setSource('foodics');
            nextSource = 'foodics';
          }
        }
        AsyncStorage.setItem(
          cacheKey,
          JSON.stringify({
            products: nextProducts,
            categories: nextCategories,
            branches: nextBranches,
            source: nextSource,
          })
        ).catch(() => {});
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Failed to load menu');
        setSource('local');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchMenu();
    const appStateSub = AppState.addEventListener('change', (state) => {
      if (state === 'active') fetchMenu();
    });
    return () => {
      cancelled = true;
      appStateSub.remove();
    };
  }, [merchantId]);

  return { products, categories, branches, loading, error, source };
}
