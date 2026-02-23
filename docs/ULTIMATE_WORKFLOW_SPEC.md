# Ultimate workflow – full spec (website + app)

This doc describes the end-to-end flow: merchant landing → signup → wizard → payment → builds → dashboard, and the customer app flow. Use it to align **nooksweb** (merchant website/dashboard) and **ALS_draft0** (customer app + API).

**No real Foodics data yet** – all Foodics integration is stubbed/mock until APIs are available.

---

## Part 1: Merchant website (nooksweb)

### 1.1 First page (landing)

- **Goal:** Show what we do; reassure: integrates with Foodics POS, no delivery fleet to manage.
- **UI inspiration:** Borrow from [lightweight.info](https://lightweight.info/en) and [reactbit.com](https://reactbit.com) – creative, clear value prop.
- **Customization wizard on first page:** Let the user play with it (icon + colors). Model the wizard to match the app’s 4 tabs: **Menu, Offers, Orders, More** (nooksweb agent has reference images).
- **CTA:** “Get started” → signup page.

### 1.2 Signup

- Options: sign up with **email** or **sign in with Foodics**.
- **Message:** “To access our services you need a Foodics account.”
- If user signs in with **Foodics** → go straight to **wizard** (no extra step).

### 1.3 Wizard (after signup or Foodics sign-in)

- **4 tabs:** 1–Menu, 2–Offers, 3–Orders, 4–More (match app layout from reference images).
- User picks **icon** and **colors**.
- On **Save & continue** → **payment page**.

### 1.4 Payment page

- **1 plan** only.
- **Rule:** Do not allow payment until the user has connected their **Foodics** account.
- **Message:** “You must have a Foodics account to access our services.” (Show only if not yet connected.)
- If user already signed in with Foodics → no warning; allow payment.
- After Foodics connection we get **menu** and **branch locations** (when APIs exist).
- After **successful payment** → trigger **2 builds** (Android + iOS) with wizard specs (POST to our `/build` webhook) → then navigate to **dashboard**.

### 1.5 Dashboard (after payment)

- **Pages:**  
  1. **Dashboard** – Today’s app sales, number of active orders, latest orders.  
  2. **Live Operations** – Store status (open / busy / closed), prep time slider (minutes busy), Delivery mode (fail-safe: if OTO returns “No Drivers”, switch to Pickup only; merchant can turn delivery off at will). Menu availability (show/hide items in app without changing POS).  
  3. **Marketing Studio** – Banners (upload images, deep links to Foodics categories/products; horizontal slider below header + popup promos), Push notifications, Promo engine (codes with name, amount, expiration; validated before orders go to Foodics).  
  4. **Analytics** – App performance (sales from app, last 14 days), Customer leaderboard (top spenders, target VIPs with discounts).  
  5. **Settings** – Branch verification & POS integration (Merchant ID, Branding API URL, Foodics connection status, menu sync, branch verification for OTO).  
  6. **Help.**

- **Live Operations ↔ app:** Store status, prep time, and delivery mode must stay in sync with the app (e.g. via `GET …/merchants/{id}/operations` or Supabase Realtime on `app_config`).

---

## Part 2: Customer app (ALS_draft0)

### 2.1 Auth

- **First screen:** Sign-in (email + password).
- After submit → **OTP verification** (6-digit code).
- After OTP → **main Menu tab**.

### 2.2 Menu tab

- **Promo popup:** If merchant uploaded a promotional image in the dashboard, show it as a popup on open (dismissible).
- **Header (left → right):**  
  - Delivery/Pickup button (opens modal: Pickup = list branches by distance; Delivery = saved addresses + “Add new” with map, labels Home/Work/Other/custom, “Use my current location”, “Save for later” / “Use for this delivery only”).  
  - **Delivery:** System **auto-selects closest available branch** for delivery (do not show full branch list for delivery).  
  - **Search** (opens page with all menu items; cart visible on search page).  
  - **Merchant icon** (from wizard) at **far right** of header.
- **Below header:** Horizontal **promo slider** (images from Marketing Studio).
- **Menu:** Section list from Foodics (with options); no real Foodics data yet → use mock.

### 2.3 Offers tab

- Promotional images from Marketing Studio + promo codes from Marketing Studio.

### 2.4 Orders tab

- Full **order history**; each order shows **status**.
- **Delivered order** → tap opens **detail modal** with order details + **Re-order** button (adds items to cart and navigates to menu).
- **In-progress order** → tap opens detail with **status** (Preparing → Ready → On the way → Delivered), **map** with driver location, and **notifications** for status updates.

### 2.5 More tab

- Profile, Favorites, Addresses, Payment methods (saved card), **Language toggle** (Arabic / English).

### 2.6 Cart & checkout

- **Cart modal:** Edit items, change delivery/pickup, proceed to checkout.
- **Checkout:** No editing of delivery/pickup or items; show summary; **promo code** field (codes from Marketing Studio); pay with **Credit card** or **Apple Pay** → after success navigate to **Orders** tab.

### 2.7 Operations (store status & delivery mode)

- App must respect **store_status** (open / busy / closed) and **delivery_mode** (delivery_and_pickup / pickup_only) from `GET …/merchants/{merchantId}/operations` (or Realtime).  
- When **closed** → show message / disable adding to cart.  
- When **pickup_only** → hide or disable delivery option (sync with dashboard “turn off delivery”).

---

## Part 3: Backend (ALS_draft0 server)

- **Build webhook** – POST `/build` (Nooks calls after payment); trigger Android + iOS builds; require `x-nooks-secret` when set.  
- **Operations** – App polls (or Realtime) for store_status, prep_time_minutes, delivery_mode; nooksweb writes these (e.g. to `app_config` or Operations API).  
- **Promo codes** – Validated before orders are sent to Foodics; name, amount, expiration (Marketing Studio).  
- **Branches / menu** – When Foodics APIs exist, sync branches and menu; until then use mock data.  
- **Orders** – Push to Foodics when available; status updates and driver location (OTO) for in-app and notifications.

---

## Part 4: What nooksweb must implement (summary)

1. **Landing:** First page with wizard-on-page, value prop (Foodics + no fleet), “Get started”.  
2. **Signup:** Email or Foodics; warning that Foodics account is required.  
3. **Wizard:** 4 tabs (Menu, Offers, Orders, More), icon + colors, Save → payment.  
4. **Payment:** One plan; block payment until Foodics connected; after payment call ALS_draft0 `/build` webhook → then redirect to dashboard.  
5. **Dashboard:** Dashboard, Live Operations, Marketing Studio, Analytics, Settings, Help (as above).  
6. **Operations API:** Expose or write `store_status`, `prep_time_minutes`, `delivery_mode` so the app can poll or subscribe (e.g. `GET …/merchants/{id}/operations` or Supabase Realtime).

## Part 5: What ALS_draft0 implements (summary)

1. **App:** Auth (email + OTP), menu (header with delivery/pickup, search, merchant icon), promo slider & popup, offers, orders (history + detail + reorder + status + map + notifications), More (profile, favorites, addresses, payment, language), cart & checkout (promo code, card/Apple Pay), operations-aware (store status, delivery mode).  
2. **Server:** Build webhook, operations contract, promo validation, branches/menu/orders when Foodics available.
