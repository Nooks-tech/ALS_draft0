/**
 * Fetches menu from Nooks (when URL set) / Foodics API with fallback to local data
 */
import { useEffect, useState } from 'react';
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<'local' | 'foodics' | 'nooks'>('local');

  useEffect(() => {
    let cancelled = false;

    async function fetchMenu() {
      try {
        // Branches: Nooks first (when API URL + merchant set), then Foodics, then local
        const nooksBranches = await fetchNooksBranches(merchantId);
        if (cancelled) return;
        if (nooksBranches.length > 0) {
          setBranches(
            nooksBranches.map((b) => ({
              id: b.id,
              name: b.name,
              address: b.address ?? '',
              distance: b.distance,
            }))
          );
          setSource('nooks');
        } else {
          const branchesData = await foodicsApi.getBranches();
          if (cancelled) return;
          if (branchesData?.length) {
            setBranches(branchesData);
            setSource('foodics');
          }
        }

        const data = await foodicsApi.getMenu();
        if (cancelled) return;
        if (data?.products?.length) {
          setProducts(
            data.products.map((p) => ({
              ...p,
              category: p.category || 'Menu',
            }))
          );
          if (data.categories?.length) {
            setCategories(['All', ...data.categories]);
          }
          setSource((s) => (s === 'local' ? 'foodics' : s));
        }
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Failed to load menu');
        setSource('local');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchMenu();
    return () => { cancelled = true; };
  }, [merchantId]);

  return { products, categories, branches, loading, error, source };
}
