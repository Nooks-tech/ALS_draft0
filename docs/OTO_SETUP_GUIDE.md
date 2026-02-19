# OTO Integration Setup Guide

Complete walkthrough to ensure your OTO delivery integration is configured correctly. Use this to spot any missed steps.

---

## 1. Account & API Access

### 1.1 Create / Log in to OTO
- Go to [app.tryoto.com](https://app.tryoto.com) and sign up or log in
- Confirm you’re on **Production** (or Sandbox for testing – use `https://staging-api.tryoto.com`)

### 1.2 Get Refresh Token
1. Go to **Settings → Developers → API Integrations**
2. Click **Connect**
3. Fill in **Store Name** (e.g. "Nooks" or "ALS")
4. Click **Save**
5. Copy the generated **Refresh Token**

**In your app:** add to `server/.env`:
```env
OTO_REFRESH_TOKEN=your_actual_refresh_token
```

### 1.3 Verify Auth
```bash
curl http://localhost:3001/api/oto/health
```
Expected: `{"ok":true,"message":"OTO connected"}`

---

## 2. Pickup Location

OTO needs at least one pickup location to create shipments.

### 2.1 Create via API (or Dashboard)
Use `POST /rest/v2/createPickupLocation` with:
- **name** – e.g. "Nooks Branch 1"
- **code** – e.g. "NOOKS-MADINAH"
- **city** – e.g. "Madinah"
- **country** – "SA"
- **address** – full street address
- **mobile** – contact phone
- **contactName** – contact person
- **contactEmail** – valid email
- **lat**, **lon** – coordinates (recommended; helps assignment)

### 2.2 Or create in OTO Dashboard
- **Integrations** or **Pickup Locations** → **Add Location**

### 2.3 Get the Pickup Location Code
After creation, note the `pickupLocationCode` (e.g. "DMUD2812" or "NOOKS-MADINAH").

**In your app:** add to `server/.env`:
```env
OTO_PICKUP_LOCATION_CODE=your_pickup_code
```

---

## 3. Delivery Companies: Two Paths

### Path A: OTO’s Contracts (checkOTODeliveryFee)
- Uses **OTO’s** agreements with carriers
- No separate carrier activation
- Returns carriers OTO has enabled for your account

You get: SMSA, Aramex, J&T, Aymakan, Naqel, etc.  
You don’t get: Careem, Barq, Mrsool (they may not be in OTO’s standard contracts for your plan or route)

### Path B: Your Own Contracts (checkDeliveryFee + DC Activation)
- Uses **your** contracts with carriers
- Requires **DC Activation** for each carrier
- Needs credentials (Careem, Barq, Mrsool, etc.)

**DC Activation:**
1. Call `POST /rest/v2/dcConfig` with `{"code":"careem"}` to get required fields
2. Call `POST /rest/v2/dcActivation` with `code`, `deliveryOptionName`, and `settings`
3. Use your credentials for that carrier

**Plan limits:**
- Free: 1 DC
- Starter: 3 DCs
- Scale/Enterprise: unlimited

---

## 4. Restrict to Careem, Barq, Mrsool Only

The app filters delivery options to **only** Careem, Barq, and Mrsool via `OTO_PREFERRED_CARRIERS` in `.env`:

```env
OTO_PREFERRED_CARRIERS=careem,mrsool,barq
```

- **Delivery options API** – returns only these three (when OTO has them enabled)
- **Order creation** – pass `deliveryOptionId` from the selected option, or set `OTO_DELIVERY_OPTION_ID` in `.env`
- To allow all carriers, set `OTO_PREFERRED_CARRIERS=` (empty)

---

## 5. Multi-Branch Setup (Multiple Pickup Locations)

For multiple branches across cities, each branch needs its own OTO pickup location.

### 5.1 Branch OTO Config

Branches come from **Foodics** (when `FOODICS_API_TOKEN` is set) or from local `src/data/menu.ts`. The app resolves OTO config in this order:

1. **Exact branch ID** – Local branches use IDs like `madinah-1`, `riyadh-1`.
2. **Foodics ID map** – Add Foodics branch IDs to `FOODICS_BRANCH_ID_MAP` in `branchOtoConfig.ts`.
3. **Name matching** – If the ID is not mapped, branch names are matched (e.g. "Nooks Madinah - Central" → Madinah config).

**If using Foodics:**

1. Create branches in your Foodics dashboard (e.g. "Nooks Madinah - Central", "Nooks Riyadh - Olaya").
2. Either:
   - **Option A:** Use names that match the built-in patterns (contain "madinah"/"riyadh", optionally "central", "olaya", "king fahd").
   - **Option B:** Get branch IDs from `/api/foodics/branches`, then add them to `FOODICS_BRANCH_ID_MAP` in `src/config/branchOtoConfig.ts`:

```ts
export const FOODICS_BRANCH_ID_MAP: Record<string, string> = {
  'your-foodics-branch-uuid-1': 'madinah-1',
  'your-foodics-branch-uuid-2': 'riyadh-1',
};
```

**Local config (when not using Foodics):**

```ts
export const BRANCH_OTO_CONFIG: Record<string, BranchOtoConfig> = {
  'madinah-1': { otoPickupLocationCode: 'NOOKS-MADINAH-01', city: 'Madinah', lat: 24.4672, lon: 39.6111 },
  'riyadh-1': { otoPickupLocationCode: 'NOOKS-RIYADH-01', city: 'Riyadh', lat: 24.7136, lon: 46.6753 },
};
```

### 5.2 Create OTO Pickup Locations

The script creates/updates Madinah and Riyadh pickup locations:

```bash
cd server && npx tsx scripts/oto-pickup-setup.ts
```

To add more cities, edit `PICKUPS` in `server/scripts/oto-pickup-setup.ts`, then run the script. Add the new branch to `src/config/branchOtoConfig.ts`.

### 5.3 Flow

- At checkout, the app fetches delivery options using branch city + customer city (and lat/lon for Mrsool Bullet).
- The first available option (Mrsool for same-city, express for cross-city) is used.
- `pickupLocationCode` from branch config is sent to OTO so the correct branch is used as pickup.

---

## 6. Why Careem / Barq / Mrsool Are Missing

They are in `dcList`, but they’re not returned by `checkOTODeliveryFee` because:

1. **OTO contracts** – Careem/Barq/Mrsool may not be in OTO’s marketplace contracts for your plan/route  
2. **Route** – Madinah → Riyadh may not be supported for these quick-delivery providers (often same-city only)  
3. **Your contracts** – They might only appear via `checkDeliveryFee` after you activate them with your own contracts

**Suggested next steps:**
- Ask OTO support whether Careem, Barq, and Mrsool are available via `checkOTODeliveryFee` for your plan and Madinah → Riyadh
- If not, ask how to enable them (DC Activation, plan upgrade, or different route)

---

## 7. City Names

OTO expects cities in their format.

**Get valid cities:**
```http
POST /rest/v2/getCities
{"country":"SA","perPage":100,"page":1}
```

Use the returned city names (e.g. "ar rass", "Riyadh", "Jeddah") in `checkOTODeliveryFee`.

---

## 8. checkOTODeliveryFee Parameters

Your current request is fine. Optional tweaks:

| Parameter        | Your value | Notes                                         |
|------------------|------------|-----------------------------------------------|
| originCity       | Madinah    | Match `getCities` names                       |
| destinationCity  | Riyadh     | Match `getCities` names                       |
| weight           | 0.5        | kg                                            |
| serviceType      | (omit)     | Omit = all types. Try `sameDay`, `express`    |
| originCountry    | SA         | Helpful if documented                         |
| destinationCountry | SA      | Helpful if documented                         |

**`boxes` format** (alternative to `weight`):
```json
{
  "originCity": "Madinah",
  "destinationCity": "Riyadh",
  "boxes": [{"width":30,"length":30,"height":20,"weight":0.5,"boxName":"Box1"}]
}
```

---

## 9. Create Order / Request Delivery

Your `requestDelivery` → `createOrder` setup is correct. Ensure:

- **customer.phone** – digits only, no `+`
- **deliveryAddress** – full address; include **lat** and **lng** when possible
- **deliveryAddress.city** – matches OTO city names
- **OTO_PICKUP_LOCATION_CODE** – fallback when branch has no OTO config
- **pickupLocationCode** – per-branch override (from `branchOtoConfig.ts`)
- **deliveryOptionId** – from `getDeliveryOptions` at checkout, or `OTO_DELIVERY_OPTION_ID` in `.env`

---

## 10. Checklist Summary

| Step                   | Status | Action                               |
|------------------------|--------|--------------------------------------|
| OTO account            | ⬜     | Sign up / log in                     |
| Refresh token          | ⬜     | Settings → Developers → API Integrations |
| Health check passes    | ⬜     | `GET /api/oto/health`                |
| Pickup location exists | ⬜     | Dashboard or createPickupLocation    |
| OTO_PICKUP_LOCATION_CODE | ⬜   | Set in `.env`                        |
| Delivery options       | ⬜     | `GET /api/oto/delivery-options`      |
| Careem/Barq/Mrsool     | ⬜     | Contact OTO support if missing       |

---

## 11. API Endpoints You Can Call

| Endpoint                 | Purpose                                          |
|--------------------------|--------------------------------------------------|
| `GET /api/oto/health`    | Test auth                                        |
| `GET /api/oto/dc-list`   | List all OTO carriers                            |
| `GET /api/oto/delivery-options?originCity=X&destinationCity=Y` | Get rates and options           |
| `POST /api/oto/request-delivery` | Create order and request delivery            |

---

## 11. If Careem / Barq / Mrsool Still Don’t Appear

1. **Contact OTO support** – Provide account details, route (Madinah → Riyadh), and ask how to enable Careem, Barq, and Mrsool
2. **Test same-city** – Try `originCity=Riyadh&destinationCity=Riyadh` (Careem/Barq often same-city only)
3. **Test `serviceType`** – `sameDay`, `express`, `fastDelivery`
4. **Check dashboard** – Confirm which carriers are active for your account and which routes are covered
