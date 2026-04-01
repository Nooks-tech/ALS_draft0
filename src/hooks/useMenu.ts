/**
 * Fetches merchant-scoped menu/branches from Nooks public APIs with fallback to local data
 */
import { useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState } from 'react-native';
import { MenuProduct } from '../api/foodics';
import { fetchNooksBranches } from '../api/nooksBranches';
import { fetchNooksMenu } from '../api/nooksMenu';
import { BRANCHES, CATEGORIES, PRODUCTS } from '../data/menu';
import { useMerchant } from '../context/MerchantContext';

export type MenuItem = MenuProduct & {
  category: string;
  foodicsProductId?: string | null;
  nooksProductId?: string | null;
};

const mapToMenuItem = (p: (typeof PRODUCTS)[0]): MenuItem => ({
  id: p.id,
  name: p.name,
  price: p.price,
  category: p.category,
  description: p.description,
  image: p.image,
  foodicsProductId: null,
  nooksProductId: null,
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
  const [source, setSource] = useState<'local' | 'nooks'>('local');

  useEffect(() => {
    let cancelled = false;
    const cacheKey = `@als_menu_${merchantId || 'default'}`;
    let nextProducts = PRODUCTS.map(mapToMenuItem);
    let nextCategories = CATEGORIES.filter((c) => c !== 'All');
    let nextBranches = BRANCHES;
    let nextSource: 'local' | 'nooks' = 'local';

    AsyncStorage.getItem(cacheKey).then((raw) => {
      if (!raw || cancelled) return;
      try {
        const cached = JSON.parse(raw) as {
          products?: MenuItem[];
          categories?: string[];
          branches?: typeof BRANCHES;
          source?: 'local' | 'nooks';
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
        // Branches: Nooks first, then local fallback
        const nooksBranches = await fetchNooksBranches(merchantId);
        if (cancelled) return;
        if (nooksBranches.length > 0) {
          nextBranches = nooksBranches.map((b) => ({
            id: b.id,
            name: b.name,
            address: b.address ?? '',
            distance: b.distance,
            oto_warehouse_id: b.oto_warehouse_id,
            latitude: typeof b.latitude === 'number' ? b.latitude : undefined,
            longitude: typeof b.longitude === 'number' ? b.longitude : undefined,
          }));
          setBranches(nextBranches);
          setSource('nooks');
          nextSource = 'nooks';
        }

        const nooksMenu = await fetchNooksMenu(merchantId);
        if (cancelled) return;
        if (nooksMenu?.categories?.length) {
          const flatProducts = nooksMenu.categories.flatMap((category) =>
            (category.items ?? [])
              .filter((item) => item.is_available !== false)
              .map((item) => {
                const foodicsProductId = typeof item.foodics_product_id === 'string' && item.foodics_product_id.trim()
                  ? item.foodics_product_id.trim()
                  : null;
                const nooksProductId = typeof item.id === 'string' ? item.id : '';
                if (!foodicsProductId && !nooksProductId) return null;
                return {
                  id: foodicsProductId || nooksProductId,
                  name: item.name || 'Item',
                  price: Number(item.price ?? 0),
                  category: category.name || 'Menu',
                  description: item.description || '',
                  image: item.image_url || '',
                  foodicsProductId,
                  nooksProductId,
                  modifierGroups: (item.modifier_groups ?? []).map((group) => ({
                    id: group.id,
                    title: group.title,
                    options: (group.options ?? []).map((option) => ({
                      id: option.id,
                      name: option.name,
                      price: Number(option.price ?? 0),
                    })),
                  })),
                } as MenuItem;
              })
              .filter((item): item is MenuItem => Boolean(item))
          );
          if (flatProducts.length > 0) {
            nextProducts = flatProducts;
            nextCategories = nooksMenu.categories.map((c) => c.name).filter(Boolean);
            setProducts(nextProducts);
            setCategories(nextCategories);
            setSource('nooks');
            nextSource = 'nooks';
            AsyncStorage.setItem(
              cacheKey,
              JSON.stringify({
                products: nextProducts,
                categories: nextCategories,
                branches: nextBranches,
                source: nextSource,
              })
            ).catch(() => {});
            return;
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
