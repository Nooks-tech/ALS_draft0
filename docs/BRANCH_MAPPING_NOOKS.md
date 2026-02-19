# Branch Mapping: Nooks ↔ ALS_draft0

This doc describes how branch identity and OTO pickup codes align between **Nooks** (nooksweb) and **ALS_draft0** so both use the same branches and OTO locations.

---

## Why It Matters

- **Nooks** (merchant dashboard) lets merchants configure branches and map them to OTO pickup locations (e.g. in `branch_mappings`).
- **ALS_draft0** (customer app) needs to use the **same** branch identity and OTO codes when:
  - Showing the branch list (local or from Foodics)
  - Sending the correct `pickupLocationCode` and origin city to OTO for delivery
  - Storing `branchId` / `branchName` on orders for Nooks or reporting

If IDs or names don’t match, delivery options and order attribution can be wrong.

---

## How ALS_draft0 Resolves Branch → OTO Config

1. **Local branches** (in `src/data/menu.ts`) use IDs: `madinah-1`, `madinah-2`, `riyadh-1`, `riyadh-2`.
2. **OTO config** is in `src/config/branchOtoConfig.ts`:
   - Each ID maps to: `otoPickupLocationCode`, `city`, `lat`, `lon`.
   - Madinah branches → `NOOKS-MADINAH-01`, city `Madinah`.
   - Riyadh branches → `NOOKS-RIYADH-01`, city `Riyadh`.
3. **Foodics branches:** When branches come from the Foodics API, we either:
   - Map Foodics branch **IDs** in `FOODICS_BRANCH_ID_MAP` (e.g. `"foodics-uuid"` → `"madinah-1"`), or
   - Match by **name** (e.g. names containing "madinah" / "riyadh", "central", "olaya", "king fahd") so the right OTO config is used.

So: **branch id or name** (from Nooks/Foodics or our local list) → **OTO config** (pickup code + city + coords).

---

## Nooks Side (What to Align With)

- Nooks uses **branch_mappings** (and possibly Foodics branch IDs) to associate branches with OTO warehouses/pickup codes.
- When configuring a branch in Nooks, use:
  - **Same names or IDs** that ALS_draft0 expects (e.g. if Nooks stores a branch name like "Nooks Madinah - Central", our name-matching will map it to Madinah OTO config).
  - **Same OTO pickup location codes**: `NOOKS-MADINAH-01` for Madinah, `NOOKS-RIYADH-01` for Riyadh (or whatever is created in OTO and used in `server/scripts/oto-pickup-setup.ts`).

If Nooks uses **internal IDs** (e.g. UUIDs) for branches, then in ALS_draft0 we need those IDs in `FOODICS_BRANCH_ID_MAP` mapping to our config keys (`madinah-1`, `riyadh-1`, etc.), or Nooks can expose branch names that match our name patterns.

---

## Summary Table (ALS_draft0)

| Branch (ALS_draft0)   | ID (local)  | OTO pickup code    | City   |
|-----------------------|------------|--------------------|--------|
| Nooks Madinah – Central | `madinah-1` | `NOOKS-MADINAH-01` | Madinah |
| Nooks Madinah – King Fahd Road | `madinah-2` | `NOOKS-MADINAH-01` | Madinah |
| Nooks Riyadh – Olaya  | `riyadh-1` | `NOOKS-RIYADH-01`  | Riyadh |
| Nooks Riyadh – King Fahd Road | `riyadh-2` | `NOOKS-RIYADH-01`  | Riyadh |

**Config file:** `src/config/branchOtoConfig.ts`  
**Pickup locations (OTO):** Created/updated with `server/scripts/oto-pickup-setup.ts`

---

## Nooks schema (from nooksweb)

Nooks’ **`branch_mappings`** table uses: **`id`** (uuid, Nooks branch id), **`foodics_branch_id`** (text), **`name`** (text), **`oto_warehouse_id`** (text = OTO pickup location code), **`latitude`**, **`longitude`**. When we load branches from a future Nooks API, we’ll use `branch_mappings.id` as branch id and `oto_warehouse_id` as the OTO code. See **`docs/NOOKSWEB_ANSWERS.md`**.

---

## Option B (Future)

When nooksweb exposes an API (or Supabase view) for “branches + OTO config for merchant X”, ALS_draft0 can load branches from that API and use the same mapping logic (id → `oto_warehouse_id` + city from coords). Until then, this mapping doc and `branchOtoConfig.ts` are the source of truth for alignment.
