# SaaS Financial Model And Vendor Capability Map

This report is a VAT-inclusive management view because that is what was requested. For statutory accounting, VAT should normally be treated as pass-through rather than operating revenue or operating expense.

## Executive Summary
- Target outcome: reach `500` net active merchants by `Month 12`.
- Base-case year 1 revenue: `2,063,469.90 SAR`.
- Base-case year 1 operating profit: `510,045.90 SAR`.
- Base-case year 1 GMV processed through the platform: `36,276,390.00 SAR`.
- Monthly operating profit turns positive in `Month 7` and cumulative profit turns positive in `Month 10`.
- At steady state (`500` mature merchants), monthly operating profit reaches `344,835.38 SAR`.

## Base-Case Assumptions
| Assumption | Base Case | Why it is reasonable |
| --- | --- | --- |
| Average order value | 41 SAR | Balanced between cafe tickets and higher restaurant delivery baskets in Saudi Arabia. |
| Orders per merchant | 540/month (18/day) | Suitable for branded merchant apps, not total POS volume. |
| Delivery mix | 40.0% | Branded apps usually skew more to pickup than pure aggregator channels. |
| Monthly active customers | 340/merchant | Implies roughly 1.6 orders per active customer each month. |
| New customers | 70/merchant/month | Keeps SMS cost low but not zero; realistic once repeat use starts compounding. |
| Payment mix | 50% Apple Pay on mada, 20% direct mada, 20% Apple Pay/card, 7% direct cards, 3% other | Reflects Saudi mobile-wallet behavior while keeping mada dominant overall. |
| Merchant growth | 6 -> 500 net active merchants in 12 months | Slow early sales, then faster growth from referrals, partnerships, and onboarding process maturity. |
| Order ramp after launch | 40% / 70% / 90% / 100% | New merchants need time to get app downloads and repeat usage. |

## Unit Economics
| Metric | Pickup | Delivery |
| --- | --- | --- |
| Revenue per order | 1.410 SAR | 2.410 SAR |
| Cost per order | 0.063 SAR | 0.563 SAR |
| Gross profit per order | 1.347 SAR | 1.847 SAR |
| Who pays gateway percentages | Merchant | Merchant |
| What you still pay | 0.05 SAR tokenization + SMS share | 0.05 SAR tokenization + SMS share + 0.5 SAR OTO variable fee |

### Payer Separation
| Payer | What they pay | How it appears in the model |
| --- | --- | --- |
| Merchant | 1% commission on order value and Moyasar percentage fees | Your revenue captures the 1% commission; merchant-side PSP percentage fees are excluded from your cost base. |
| Customer | 1 SAR service fee on every order and 1 SAR extra on delivery orders | These create the fixed order fee and delivery markup revenue lines. |
| Your company | 0.05 SAR tokenization, 0.1 SAR per new-user auth, 0.5 SAR per delivery, Foodics, OTO plan, payroll, infra, and sales overhead | These appear in direct costs and operating expenses. |

Notes:
- The model assumes the merchant pays Mada and card percentage fees to Moyasar, not your company.
- The `1 SAR` fraud fee is treated as covered by your `1 SAR` service fee, per your instruction.
- The `0.05 SAR` tokenization fee is modeled as your cost on each successful order.
- OTO is modeled conservatively with both the fixed `399 SAR` Scale plan and your stated `0.5 SAR` delivery cost on delivery orders.

## Per-Merchant Monthly Economics
The table below uses a fully ramped merchant at the `500-merchant` scale point.

| Metric | Per Merchant Per Month |
| --- | --- |
| Subscription revenue | 250.00 SAR |
| Order revenue | 977.40 SAR |
| Total revenue | 1227.40 SAR |
| Direct variable costs | 142.00 SAR |
| Allocated Foodics cost | 34.93 SAR |
| Allocated OTO plan cost | 0.80 SAR |
| Allocated overhead | 360.00 SAR |
| Net operating profit | 689.67 SAR |

## Full Business Monthly Breakdown
| Month | End Merchants | Orders | Revenue (SAR) | Direct Costs (SAR) | Opex (SAR) | Profit (SAR) |
| --- | --- | --- | --- | --- | --- | --- |
| Month 1 | 6 | 1,296 | 3,095.76 | 1,817.93 | 45,000.00 | -43,722.17 |
| Month 2 | 15 | 4,212 | 10,248.72 | 2,584.72 | 50,000.00 | -42,336.01 |
| Month 3 | 28 | 9,126 | 21,893.06 | 3,980.43 | 55,000.00 | -37,087.36 |
| Month 4 | 45 | 16,200 | 38,447.00 | 6,427.12 | 65,000.00 | -32,980.12 |
| Month 5 | 68 | 25,812 | 60,844.72 | 9,748.23 | 75,000.00 | -23,903.50 |
| Month 6 | 98 | 38,556 | 90,536.36 | 14,134.42 | 85,000.00 | -8,598.07 |
| Month 7 | 138 | 55,458 | 129,878.98 | 19,959.03 | 100,000.00 | 9,919.95 |
| Month 8 | 190 | 77,652 | 181,550.12 | 27,589.23 | 120,000.00 | 33,960.89 |
| Month 9 | 255 | 106,056 | 247,586.36 | 37,300.93 | 140,000.00 | 70,285.43 |
| Month 10 | 335 | 141,642 | 330,122.02 | 49,418.73 | 155,000.00 | 125,703.30 |
| Month 11 | 420 | 182,790 | 425,224.90 | 63,171.62 | 170,000.00 | 192,053.28 |
| Month 12 | 500 | 225,990 | 524,041.90 | 77,291.62 | 180,000.00 | 266,750.28 |

## Year 1 Totals
| Metric | Year 1 Total |
| --- | --- |
| Orders | 884,790 |
| GMV | 36,276,390.00 SAR |
| Revenue | 2,063,469.90 SAR |
| Direct costs | 313,424.00 SAR |
| Operating expenses | 1,240,000.00 SAR |
| Operating profit | 510,045.90 SAR |

## 500-Merchant Steady-State Snapshot
| Metric | 500-Merchant Steady State |
| --- | --- |
| Active merchants | 500 |
| Orders per month | 270,000 |
| GMV per month | 11,070,000.00 SAR |
| Revenue per month | 613,700.00 SAR |
| Direct costs per month | 88,864.62 SAR |
| Gross profit per month | 524,835.38 SAR |
| Operating expenses per month | 180,000.00 SAR |
| Operating profit per month | 344,835.38 SAR |

## Sensitivity Cases
| Scenario | Revenue (SAR) | Direct Costs (SAR) | Operating Profit (SAR) |
| --- | --- | --- | --- |
| Base case at 500 merchants | 613,700.00 | 88,864.62 | 344,835.38 |
| Order volume down 20% | 515,960.00 | 74,664.62 | 261,295.38 |
| Delivery mix falls to 25% | 573,200.00 | 68,614.62 | 324,585.38 |
| Delivery mix rises to 55% | 654,200.00 | 109,114.62 | 365,085.38 |
| Slower merchant ramp to 350 by month 12 | 1,436,670.18 | 221,242.90 | -24,572.72 |

Interpretation:
- Lower order volume hurts more than delivery-mix changes because your per-order monetization is the main economic engine.
- A higher delivery mix helps under the current rules because the extra `1 SAR` markup is larger than the modeled `0.5 SAR` OTO variable cost.
- Slower merchant growth is the biggest risk in year 1 because fixed payroll and sales spending arrive before the merchant base fully compounds.

## Risks And Weaknesses In The Model
- `Foodics` pricing is modeled as `$250/month` up to `25` merchants, then `$8` for each merchant above `25`, converted at `3.75 SAR/USD` and grossed up for VAT. If the real contract structure differs, direct margin will move.
- `OTO` public pricing includes fee-free shipment allowances, but the model follows your stated `0.5 SAR` per-delivery cost rule to stay conservative and simple.
- `250 SAR` monthly subscription is a low base price for a merchant-branded app product. The model still works, but it depends heavily on merchants generating real app order volume.
- SMS cost is small in the base case. If your merchants rely heavily on one-time visitors rather than repeat buyers, this line will rise.
- The model assumes limited churn because the goal is framed as reaching `500` merchants by year end. If churn rises, the sales burden increases sharply.
- VAT-inclusive reporting makes the model easier to match to gross cash movement, but it is not the cleanest view for formal accounting.

## Pricing Improvements
- Keep the current model for acquisition, but introduce a higher standard plan (`349-399 SAR`) for merchants once onboarding is proven.
- Add a one-time onboarding or branding fee (`500-1,000 SAR`) to reduce CAC payback pressure in the first six months.
- Consider a minimum monthly variable-fee floor for very low-volume merchants so support time is not subsidized forever.
- Preserve the `+1 SAR` delivery markup. It is one of the clearest margin levers in the model.

## Vendor Capability Map
### Foodics
Current repo already uses:
- Menu and modifier retrieval in `server/services/foodics.ts`.
- Branch retrieval in `server/services/foodics.ts`.
- Server-side order creation in `server/services/foodics.ts`.

Additional capabilities you can get from Foodics:
- OAuth merchant onboarding and per-merchant account linking.
- Business identity and settings via `whoami` and `settings`.
- Branch-level online-ordering flags such as `receives_online_orders`, opening hours, phone, and location metadata.
- Brand and cloud-kitchen mapping through tags.
- Charges and delivery-charge mapping for aggregator or app-originated orders.
- Price tags for channel-specific pricing without duplicating menu items.
- Combos, richer modifier rules, branch-level stock state, branch-level custom prices, and localized names.
- Nutrition facts and allergen data for richer customer menu screens.
- Order calculator support for taxes, discounts, and charge computation before final order creation.
- Paid-order posting using a third-party payment method type in Foodics.
- Customer and delivery-address creation for delivery orders.
- Webhooks for order lifecycle updates and menu updates.
- Delivery-management fields such as driver assignment, dispatch timestamps, pickup timestamps, delivery timestamps, and delivery status updates.
- Loyalty adapter flows including rewards, OTP verification, and reward-as-payment logic.

### OTO
Current repo already uses:
- Delivery creation and shipment request flow in `server/services/oto.ts`.
- Delivery-option pricing checks and carrier filtering in `server/services/oto.ts`.
- Tracking, AWB URL access, cancellation, webhook handling, and branch mapping.

Additional capabilities you can get from OTO:
- Pickup-location creation, update, and listing.
- Carrier activation checks, city coverage, and address verification style checks.
- Shipment transaction history and operational reporting.
- Return-shipment APIs and branded return flows.
- Tracking pages, tracking links, tracking history, and customer-notification workflows.
- Limited email and WhatsApp messaging on the Scale plan.
- SLA management on the Scale plan.
- Unlimited carrier connections and unlimited sales-channel integrations on the Scale plan.
- Better own-contract rate shopping versus marketplace rates when more carriers are connected.

### Moyasar
Current repo already uses:
- Invoice creation, redirect flow, and webhook handling in `server/services/payment.ts`.
- Refund and void handling in `server/services/payment.ts`.
- Apple Pay and card checkout paths in `app/checkout.tsx`.
- Fee helper logic for Mada and local cards in `server/services/payment.ts`.

Additional capabilities you can get from Moyasar:
- Direct payment creation instead of invoice-only flows.
- Apple Pay merchant validation through Moyasar APIs.
- Token creation, fetch, and deletion for saved-card experiences.
- Recurring or repeat-payment flows once tokenization is enabled on your account.
- Webhooks for `payment_paid`, `payment_failed`, `payment_refunded`, `payment_voided`, `payment_authorized`, `payment_captured`, and `payment_verified`.
- Authorization and capture flows for merchants who want manual capture logic.
- More reconciliation data such as issuer details, authorization code, response code, masked PAN, RRN, and token metadata.
- Additional supported methods depending on account enablement, such as STC Pay and Amex.

## Sources
- Current payment implementation: `server/services/payment.ts` and `app/checkout.tsx`.
- Current Foodics integration: `server/services/foodics.ts`.
- Current OTO integration: `server/services/oto.ts`.
- Build and deployment context: `eas.json` and `app.config.js`.
- Moyasar pricing agreement supplied by the user: `C:/Users/8cupc/OneDrive/سطح المكتب/document_pdf (1).pdf`.
- Public docs used for capability expansion: `https://developers.foodics.com/`, `https://docs.moyasar.com/`, and `https://tryoto.com/pricing/`.
