/**
 * OTO Pickup Location Setup
 * 1. Lists existing pickup locations
 * 2. For each configured pickup (Madinah, Riyadh): update if exists, create if not
 *
 * Run: cd server && npx tsx scripts/oto-pickup-setup.ts
 */
import 'dotenv/config';
import { otoService } from '../services/oto';

const PICKUPS = [
  {
    code: 'NOOKS-MADINAH-01',
    name: 'Nooks Madinah',
    type: 'warehouse' as const,
    city: 'Madinah',
    country: 'SA',
    address: 'Prince Mohammed Bin Abdulaziz Road, Al Madinah Al Munawwarah, Saudi Arabia',
    mobile: '500000000',
    contactName: 'Nooks',
    contactEmail: 'contact@nooks.sa',
    lat: 24.4672,
    lon: 39.6111,
    status: 'active' as const,
  },
  {
    code: 'NOOKS-RIYADH-01',
    name: 'Nooks Riyadh',
    type: 'warehouse' as const,
    city: 'Riyadh',
    country: 'SA',
    address: 'Olaya Street, Olaya District, Riyadh, Saudi Arabia',
    mobile: '500000000',
    contactName: 'Nooks',
    contactEmail: 'contact@nooks.sa',
    lat: 24.7136,
    lon: 46.6753,
    status: 'active' as const,
  },
];

async function main() {
  if (!process.env.OTO_REFRESH_TOKEN) {
    console.error('OTO_REFRESH_TOKEN not set in .env');
    process.exit(1);
  }

  console.log('1. Listing pickup locations (active + inactive)...');
  const [active, inactive] = await Promise.all([
    otoService.getPickupLocationList('active'),
    otoService.getPickupLocationList('inactive').catch(() => ({ warehouses: [] as any[], branches: [] as any[] })),
  ]);
  const all = [
    ...active.warehouses,
    ...active.branches,
    ...inactive.warehouses,
    ...inactive.branches,
  ];
  const totalWarehouses = active.warehouses.length + inactive.warehouses.length;
  const totalBranches = active.branches.length + inactive.branches.length;
  console.log(`   Found: ${totalWarehouses} warehouse(s), ${totalBranches} branch(es)\n`);

  console.log('2. Ensuring Madinah & Riyadh pickup locations...\n');

  for (const pickup of PICKUPS) {
    const existing = all.find((loc) => loc.code === pickup.code);
    const payload = {
      code: pickup.code,
      name: pickup.name,
      mobile: pickup.mobile,
      address: pickup.address,
      city: pickup.city,
      country: pickup.country,
      contactName: pickup.contactName,
      contactEmail: pickup.contactEmail,
      type: pickup.type,
      lat: pickup.lat,
      lon: pickup.lon,
      status: pickup.status,
    };

    if (existing) {
      try {
        await otoService.updatePickupLocation(payload);
        console.log(`   Updated & activated: ${pickup.name} (${pickup.code})`);
      } catch (e: any) {
        console.error(`   Update failed for ${pickup.code}:`, e?.message);
      }
    } else {
      try {
        const result = await otoService.createPickupLocation(payload);
        if (result.success) {
          const code = result.pickupLocationCode || pickup.code;
          console.log(`   Created: ${pickup.name} (${code})`);
        } else {
          console.error(`   Create failed for ${pickup.code}:`, result.message || 'Unknown error');
        }
      } catch (e: any) {
        console.error(`   Create failed for ${pickup.code}:`, e?.message);
      }
    }
  }

  console.log('\n3. Pickup location codes (used in branchOtoConfig.ts):');
  for (const p of PICKUPS) {
    console.log(`   ${p.code} - ${p.name}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
