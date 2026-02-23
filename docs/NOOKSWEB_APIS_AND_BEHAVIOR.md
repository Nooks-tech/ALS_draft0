# APIs from nooksweb and behavior (customer app)

This doc summarizes the nooksweb APIs the customer app (ALS_draft0) uses and the behavior we implement. Use it when aligning with nooksweb.

---

## APIs to use from nooksweb

| API | Purpose in app |
|-----|----------------|
| **Branding** `GET …/api/public/merchants/{merchantId}/branding` | `logo_url` → merchant icon in header (right-most). `primary_color` → header, nav, buttons, prices, accents. `accent_color` → compatibility; can use primary. `background_color` → screen and card backgrounds (default `#f5f5f4`). |
| **Banners** `GET …/api/public/merchants/{merchantId}/banners` | **Slider:** horizontal strip below the header. **Popup:** on-open popup (user can close). |
| **Promos** `GET …/api/public/merchants/{merchantId}/promos` | Offers tab and checkout; each promo has `name` (display; may equal `code`). |
| **Operations** `GET …/api/public/merchants/{merchantId}/operations` | Store status, prep time, delivery mode (`delivery_and_pickup` vs `pickup_only`). When the merchant turns off delivery on the website, the app shows pickup only. |

### Header order (Menu tab, left → right)

1. **Pickup/delivery and branch selector** (building icon + label).
2. **Search icon** – tap opens search (accessibility: “Search menu”).
3. **Merchant logo** – right-most; from `logo_url`; 40×40pt, rounded; placeholder if null (accessibility: “Merchant logo”).

---

## Behavior implemented

- **Delivery:** Auto-set the closest available branch for delivery; do not show a branch list to the customer for delivery.
- **Pickup:** Show branches ranked by distance; customer chooses.
- **Reorder:** For delivered orders, when the customer opens an order we show order details and a “Reorder” action.
- **Active orders:** Status (Preparing → Ready → On the way → Delivered), map with driver location, and notifications when status changes.
- **Checkout:** Apply promo code (from Marketing Studio / Nooks promos or Supabase); pay with credit card or Apple Pay; after payment, navigate to the Orders tab.

---

## Where in the app

- **Branding:** `MerchantBrandingContext` → `GET …/branding`; menu header uses `logoUrl` and `primaryColor`/`accentColor`.
- **Banners:** `fetchNooksBanners()` in `src/api/nooksBanners.ts`. Menu: slider uses banners with `placement === 'slider'` (or no placement); popup uses first banner with `placement === 'popup'`; fallback to local `PROMOS`.
- **Promos:** `fetchNooksPromos()` in `src/api/nooksPromos.ts`. Offers tab shows Nooks promos when available; checkout validates via Supabase `als_promo_codes` (or fallback); nooksweb can validate before orders are pushed to Foodics.
- **Operations:** `fetchNooksOperations()` in `src/api/nooksOperations.ts`; `OperationsContext` polls and exposes `isClosed`, `isPickupOnly`; menu/order-type UI hides delivery when pickup_only.

### Branding quick reference

| API field | Use for |
|-----------|--------|
| `logo_url` | Merchant icon in header (right-most); optional elsewhere. |
| `primary_color` | Header, nav, buttons, prices, accents, active states. |
| `background_color` | Screen and card backgrounds (default `#f5f5f4`). |

**Note:** If nooksweb stores branding in Supabase `app_config`, ensure `background_color` is in the schema (e.g. migration `20260222000000_app_config_background_color.sql`).
