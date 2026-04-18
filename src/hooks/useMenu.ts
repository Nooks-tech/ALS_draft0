/**
 * Fetches merchant-scoped menu, categories, and branches from Nooks public APIs.
 * Foodics (via nooksweb sync) is the SINGLE source of truth — there's no local fallback.
 * If the merchant hasn't connected Foodics yet, the app shows an empty menu.
 *
 * Cache layer: AsyncStorage holds the most recent successful Nooks response so the menu
 * loads instantly on app open while a fresh fetch runs in the background.
 */
import { useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState } from 'react-native';
import { MenuProduct } from '../api/foodics';
import { fetchNooksBranches } from '../api/nooksBranches';
import { fetchNooksMenu } from '../api/nooksMenu';
import { useMerchant } from '../context/MerchantContext';

export type MenuItem = MenuProduct & {
  category: string;
  foodicsProductId?: string | null;
  nooksProductId?: string | null;
};

export type MenuBranch = {
  id: string;
  name: string;
  name_localized?: string;
  address: string;
  distance?: string;
  oto_warehouse_id?: string;
  latitude?: number;
  longitude?: number;
  open_from?: string;
  open_till?: string;
  pickup_promising_time?: number;
  delivery_promising_time?: number;
};

export function useMenu() {
  const { merchantId } = useMerchant();
  const [products, setProducts] = useState<MenuItem[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [branches, setBranches] = useState<MenuBranch[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** 'nooks' = fetched from Foodics-synced data, 'empty' = no products yet */
  const [source, setSource] = useState<'nooks' | 'empty'>('empty');

  useEffect(() => {
    let cancelled = false;
    const cacheKey = `@als_menu_${merchantId || 'default'}`;

    // Load cache immediately so the UI doesn't flash empty on open
    AsyncStorage.getItem(cacheKey).then((raw) => {
      if (!raw || cancelled) return;
      try {
        const cached = JSON.parse(raw) as {
          products?: MenuItem[];
          categories?: string[];
          branches?: MenuBranch[];
          source?: 'nooks' | 'empty';
        };
        if (cached.products?.length) setProducts(cached.products);
        if (cached.categories?.length) setCategories(cached.categories);
        if (cached.branches?.length) setBranches(cached.branches);
        if (cached.source) setSource(cached.source);
      } catch {
        // Ignore corrupt cache
      }
    });

    async function fetchMenu() {
      if (!cancelled) setLoading(true);
      try {
        // 1) Branches
        const nooksBranches = await fetchNooksBranches(merchantId);
        if (cancelled) return;

        const nextBranches: MenuBranch[] = nooksBranches.map((b) => ({
          id: b.id,
          name: b.name,
          name_localized: b.name_localized,
          address: b.address ?? '',
          distance: b.distance,
          oto_warehouse_id: b.oto_warehouse_id,
          latitude: typeof b.latitude === 'number' ? b.latitude : undefined,
          longitude: typeof b.longitude === 'number' ? b.longitude : undefined,
          open_from: b.open_from,
          open_till: b.open_till,
          pickup_promising_time: b.pickup_promising_time,
          delivery_promising_time: b.delivery_promising_time,
        }));
        setBranches(nextBranches);

        // 2) Menu (filter by first branch's stock if any)
        const firstBranchId = nextBranches.length > 0 ? nextBranches[0].id : undefined;
        const nooksMenu = await fetchNooksMenu(merchantId, firstBranchId);
        if (cancelled) return;

        if (!nooksMenu?.categories?.length) {
          // Foodics not connected or no products synced — show empty menu
          setProducts([]);
          setCategories([]);
          setSource('empty');
          AsyncStorage.setItem(
            cacheKey,
            JSON.stringify({ products: [], categories: [], branches: nextBranches, source: 'empty' })
          ).catch(() => {});
          return;
        }

        const flatProducts: MenuItem[] = nooksMenu.categories.flatMap((category) =>
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
                modifierGroups: (item.modifier_groups ?? []).map((group) => {
                  const rawGroup = group as Record<string, unknown>;
                  const minOpt = rawGroup.minimum_options;
                  const maxOpt = rawGroup.maximum_options;
                  return {
                    id: group.id,
                    title: group.title,
                    minimumOptions: typeof minOpt === 'number' ? minOpt : null,
                    maximumOptions: typeof maxOpt === 'number' ? maxOpt : null,
                    options: (group.options ?? []).map((option) => ({
                      id: option.id,
                      name: option.name,
                      price: Number(option.price ?? 0),
                    })),
                  };
                }),
              } as MenuItem;
            })
            .filter((item): item is MenuItem => Boolean(item))
        );

        const nextCategories = nooksMenu.categories.map((c) => c.name).filter(Boolean);

        setProducts(flatProducts);
        setCategories(nextCategories);
        setSource('nooks');
        AsyncStorage.setItem(
          cacheKey,
          JSON.stringify({
            products: flatProducts,
            categories: nextCategories,
            branches: nextBranches,
            source: 'nooks',
          })
        ).catch(() => {});
      } catch (e) {
        if (cancelled) return;
        // Fetch failed — keep whatever the cache had, surface the error
        setError(e instanceof Error ? e.message : 'Failed to load menu');
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
