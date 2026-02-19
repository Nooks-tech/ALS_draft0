/**
 * Branch OTO config - maps each branch to its OTO pickup location and city.
 * Used for multi-branch delivery: each branch has its own OTO pickup code.
 *
 * Supports:
 * - Local branches: IDs madinah-1, madinah-2, riyadh-1, riyadh-2 (from src/data/menu.ts)
 * - Foodics branches: match by ID (add to FOODICS_BRANCH_ID_MAP) or by name (auto-matched)
 *
 * Madinah: NOOKS-MADINAH-01 | Riyadh: NOOKS-RIYADH-01
 */
export type BranchOtoConfig = {
  otoPickupLocationCode: string;
  city: string;
  lat: number;
  lon: number;
};

/** Branch id -> OTO config (local branches + Foodics IDs when mapped). */
export const BRANCH_OTO_CONFIG: Record<string, BranchOtoConfig> = {
  'madinah-1': {
    otoPickupLocationCode: 'NOOKS-MADINAH-01',
    city: 'Madinah',
    lat: 24.4672,
    lon: 39.6111,
  },
  'madinah-2': {
    otoPickupLocationCode: 'NOOKS-MADINAH-01',
    city: 'Madinah',
    lat: 24.4686,
    lon: 39.6098,
  },
  'riyadh-1': {
    otoPickupLocationCode: 'NOOKS-RIYADH-01',
    city: 'Riyadh',
    lat: 24.7136,
    lon: 46.6753,
  },
  'riyadh-2': {
    otoPickupLocationCode: 'NOOKS-RIYADH-01',
    city: 'Riyadh',
    lat: 24.7212,
    lon: 46.6731,
  },
};

/**
 * Map Foodics branch IDs to OTO config keys.
 * Add your Foodics branch IDs here after creating branches in Foodics dashboard.
 * Get IDs from: your-server/api/foodics/branches (or network tab when app loads).
 */
export const FOODICS_BRANCH_ID_MAP: Record<string, string> = {
  // Example: 'your-foodics-branch-uuid': 'madinah-1',
};

/** Name patterns to match Foodics branch names when ID is not mapped. Order matters (most specific first). */
const BRANCH_NAME_PATTERNS: { patterns: string[]; configKey: string }[] = [
  { patterns: ['madinah', 'central'], configKey: 'madinah-1' },
  { patterns: ['madinah', 'king fahd'], configKey: 'madinah-2' },
  { patterns: ['riyadh', 'olaya'], configKey: 'riyadh-1' },
  { patterns: ['riyadh', 'king fahd'], configKey: 'riyadh-2' },
  { patterns: ['madinah'], configKey: 'madinah-1' },
  { patterns: ['riyadh'], configKey: 'riyadh-1' },
];

function matchBranchByName(name: string): BranchOtoConfig | undefined {
  const n = (name || '').toLowerCase();
  for (const { patterns, configKey } of BRANCH_NAME_PATTERNS) {
    if (patterns.every((p) => n.includes(p))) {
      return BRANCH_OTO_CONFIG[configKey];
    }
  }
  return undefined;
}

/** Get OTO config for a branch. Supports local IDs, Foodics ID map, and name-based matching. */
export function getBranchOtoConfig(
  branchId: string,
  branchName?: string
): BranchOtoConfig | undefined {
  // 1. Exact ID match (local branches)
  const byId = BRANCH_OTO_CONFIG[branchId];
  if (byId) return byId;

  // 2. Foodics ID mapping
  const mappedKey = FOODICS_BRANCH_ID_MAP[branchId];
  if (mappedKey && BRANCH_OTO_CONFIG[mappedKey]) return BRANCH_OTO_CONFIG[mappedKey];

  // 3. Name-based fallback (Foodics branches when ID not mapped)
  if (branchName) return matchBranchByName(branchName);

  return undefined;
}
