# OTO Delivery Testing Guide

How to test the multi-branch OTO integration, Mrsool delivery, and same-city restriction.

---

## Prerequisites

- [ ] Server running (`cd server && npm run dev`)
- [ ] App running (`npx expo start`)
- [ ] Auth skipped (`SKIP_AUTH_FOR_DEV = true` in `app/index.tsx`)
- [ ] `OTO_REFRESH_TOKEN` and `OTO_PICKUP_LOCATION_CODE` in `server/.env`
- [ ] `OTO_DELIVERY_OPTION_ID=6615` (Mrsool) or let dynamic selection use first option

---

## Test 1: Same-City Delivery (Mrsool)

**Goal:** Place a delivery order in the same city as the branch → OTO shipment created with Mrsool.

1. **Select a branch** in Madinah (e.g. Dammam Branch is configured as Madinah in `branchOtoConfig` for `b1`).
   - Open app → Order type → select **Delivery**
   - Pick branch `b1` or `b2` (both point to Madinah in config)

2. **Add a delivery address in Madinah**
   - Tap "Add address" or "Use current location"
   - If using current location: ensure you're in Madinah (or use a saved address in Madinah)
   - `deliveryAddress.city` comes from reverse geocode – same city as branch

3. **Add items and go to checkout**
   - Add items → Cart → Checkout

4. **Pay**
   - Pay with Credit Card (easiest for testing)
   - Complete payment

5. **Verify**
   - **Server logs:** `[OTO] Delivery requested: { ..., carrier: 'Mrsool' }`
   - **OTO dashboard:** [app.tryoto.com](https://app.tryoto.com) → Shipping → Shipments → order appears

---

## Test 2: Cross-City Blocked

**Goal:** Delivery address in a different city → blocked before payment.

1. **Select a branch** in Madinah (branch with `city: 'Madinah'`)

2. **Add a delivery address in Riyadh**
   - Use an address with `city: 'Riyadh'` (e.g. saved address or current location in Riyadh)
   - If testing without real location: use a saved address that has `city` set to Riyadh (you may need to add one manually for testing)

3. **Go to checkout and tap Pay**
   - You should see: *"Delivery is only available within Madinah. Your address is in Riyadh. Please select a branch in Riyadh or choose pickup."*
   - Payment does **not** proceed

---

## Test 3: Per-Branch Pickup Location

**Goal:** Confirm the correct OTO pickup location is used per branch.

1. Check `src/config/branchOtoConfig.ts` – `b1` and `b2` both use `NOOKS-MADINAH-01`
2. Place a delivery order (same-city) from branch `b1`
3. In server logs, confirm `pickupLocationCode` in the OTO request
4. In OTO dashboard, open the shipment and verify pickup location matches the branch

---

## Test 4: Dynamic Carrier Selection

**Goal:** Same-city order uses Mrsool; delivery options are fetched at checkout.

1. Place a same-city delivery order
2. In server logs, you should see the OTO request with `deliveryOptionId` (e.g. 6615 for Mrsool)
3. Call the API directly to see options:
   ```bash
   curl "http://localhost:3001/api/oto/delivery-options?originCity=Madinah&destinationCity=Madinah&weight=1"
   ```
   - Should return `{"options":[{"deliveryOptionId":6615,"deliveryCompanyName":"mrsool",...}]}`

---

## Test 5: Delivery Address With City

**Goal:** City is captured from address for same-city validation.

1. Add address via **"Use my current location"**
   - `useDeliveryAddress` reverse geocodes and sets `city` (e.g. from `rev.city`)
2. Add address via **search / map**
   - City may not be set if Mapbox doesn’t return it – same-city check may be skipped when `city` is missing
3. When both branch and delivery address have `city`, and they differ, the cross-city block (Test 2) applies

---

## Test 6: Pickup Order (No OTO)

**Goal:** Pickup orders do not create OTO shipments.

1. Select **Pickup** (not Delivery)
2. Select branch, add items, checkout, pay
3. **Server logs:** No `[OTO] request-delivery received`
4. **App logs:** `[Checkout] Skipping OTO: orderType= pickup hasAddress= false`

---

## Quick Checklist

| Test                     | Expected result                                      |
|--------------------------|------------------------------------------------------|
| Same-city delivery       | OTO shipment created, Mrsool used                    |
| Cross-city delivery      | Alert, payment blocked                               |
| Per-branch pickup        | Correct pickup location in OTO                       |
| Dynamic carrier          | Mrsool for same-city, correct `deliveryOptionId`     |
| Delivery address city    | City set from location, used for validation          |
| Pickup order             | No OTO call                                          |

---

## Troubleshooting

- **No OTO call:** Ensure `orderType === 'delivery'` and `deliveryAddress?.address` is set.
- **Missing carrier in logs:** `OTO_DELIVERY_OPTION_ID` may be unset; dynamic selection should provide it when branch OTO config exists.
- **Cross-city not blocked:** Verify both `branchOto?.city` and `deliveryAddress.city` are set; branch must be in `branchOtoConfig.ts`.
- **API URL:** On a physical device, set `EXPO_PUBLIC_API_URL=http://YOUR_IP:3001` so the app can reach the server.
