from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import csv


ROOT = Path(__file__).resolve().parents[1]
DOCS_DIR = ROOT / "docs"
REPORT_PATH = DOCS_DIR / "SAAS_FINANCIAL_MODEL_AND_VENDOR_MAP.md"
CSV_PATH = DOCS_DIR / "saas_financial_model_monthly.csv"


@dataclass(frozen=True)
class Assumptions:
    vat_rate: float = 0.15
    usd_to_sar: float = 3.75
    subscription_sar: float = 250.0
    average_order_value_sar: float = 41.0
    orders_per_merchant_per_month: int = 540
    delivery_share: float = 0.40
    service_fee_sar: float = 1.0
    commission_rate: float = 0.01
    delivery_markup_sar: float = 1.0
    tokenization_cost_sar: float = 0.05
    sms_auth_cost_sar: float = 0.10
    new_customers_per_merchant_per_month: int = 70
    oto_variable_delivery_cost_sar: float = 0.50
    oto_scale_plan_monthly_sar: float = 399.0
    foodics_base_usd: float = 250.0
    foodics_extra_usd_per_merchant: float = 8.0

    @property
    def sms_cost_per_order_sar(self) -> float:
        return (
            self.sms_auth_cost_sar * self.new_customers_per_merchant_per_month
        ) / self.orders_per_merchant_per_month

    @property
    def pickup_revenue_per_order_sar(self) -> float:
        return self.average_order_value_sar * self.commission_rate + self.service_fee_sar

    @property
    def delivery_revenue_per_order_sar(self) -> float:
        return self.pickup_revenue_per_order_sar + self.delivery_markup_sar

    @property
    def pickup_cost_per_order_sar(self) -> float:
        return self.tokenization_cost_sar + self.sms_cost_per_order_sar

    @property
    def delivery_cost_per_order_sar(self) -> float:
        return self.pickup_cost_per_order_sar + self.oto_variable_delivery_cost_sar

    @property
    def foodics_base_monthly_sar(self) -> float:
        return self.foodics_base_usd * self.usd_to_sar * (1 + self.vat_rate)

    @property
    def foodics_extra_monthly_sar(self) -> float:
        return self.foodics_extra_usd_per_merchant * self.usd_to_sar * (1 + self.vat_rate)


@dataclass(frozen=True)
class MonthlyRow:
    month: str
    new_merchants: int
    end_merchants: int
    average_subscribed_merchants: float
    order_equivalent_merchants: float
    orders: float
    gmv_sar: float
    revenue_sar: float
    direct_costs_sar: float
    gross_profit_sar: float
    operating_expenses_sar: float
    operating_profit_sar: float
    cumulative_profit_sar: float


ASSUMPTIONS = Assumptions()

# Net active merchants by month-end. This curve assumes founder-led selling early,
# then faster onboarding after references and partner motion start working.
MONTHLY_NEW_MERCHANTS = [6, 9, 13, 17, 23, 30, 40, 52, 65, 80, 85, 80]

# New merchants do not hit mature app usage immediately.
ORDER_RAMP = {
    0: 0.40,  # launch month
    1: 0.70,  # first full month
    2: 0.90,  # second full month
}

# VAT-inclusive operating expense budget.
OPERATING_EXPENSES = [
    45_000,
    50_000,
    55_000,
    65_000,
    75_000,
    85_000,
    100_000,
    120_000,
    140_000,
    155_000,
    170_000,
    180_000,
]


def money(value: float) -> str:
    return f"{value:,.2f}"


def pct(value: float) -> str:
    return f"{value * 100:.1f}%"


def foodics_cost_for_merchants(merchants: int, assumptions: Assumptions) -> float:
    if merchants <= 25:
        return assumptions.foodics_base_monthly_sar
    return assumptions.foodics_base_monthly_sar + (
        (merchants - 25) * assumptions.foodics_extra_monthly_sar
    )


def ramp_factor(age_months: int) -> float:
    return ORDER_RAMP.get(age_months, 1.0)


def build_monthly_rows(assumptions: Assumptions) -> list[MonthlyRow]:
    return build_rows_with_additions(assumptions, MONTHLY_NEW_MERCHANTS, OPERATING_EXPENSES)


def build_scale_snapshot(assumptions: Assumptions) -> dict[str, float]:
    merchants = 500
    orders = merchants * assumptions.orders_per_merchant_per_month
    pickup_orders = orders * (1 - assumptions.delivery_share)
    delivery_orders = orders * assumptions.delivery_share
    revenue = (
        merchants * assumptions.subscription_sar
        + pickup_orders * assumptions.pickup_revenue_per_order_sar
        + delivery_orders * assumptions.delivery_revenue_per_order_sar
    )
    direct_costs = (
        orders * assumptions.tokenization_cost_sar
        + orders * assumptions.sms_cost_per_order_sar
        + delivery_orders * assumptions.oto_variable_delivery_cost_sar
        + assumptions.oto_scale_plan_monthly_sar
        + foodics_cost_for_merchants(merchants, assumptions)
    )
    operating_profit = revenue - direct_costs - OPERATING_EXPENSES[-1]
    return {
        "merchants": merchants,
        "orders": orders,
        "gmv_sar": orders * assumptions.average_order_value_sar,
        "revenue_sar": revenue,
        "direct_costs_sar": direct_costs,
        "gross_profit_sar": revenue - direct_costs,
        "operating_expenses_sar": OPERATING_EXPENSES[-1],
        "operating_profit_sar": operating_profit,
    }


def build_sensitivity_cases(assumptions: Assumptions) -> list[dict[str, float | str]]:
    base_foodics = foodics_cost_for_merchants(500, assumptions)
    base_opex = OPERATING_EXPENSES[-1]

    def case(name: str, order_factor: float, delivery_share: float) -> dict[str, float | str]:
        orders = 500 * assumptions.orders_per_merchant_per_month * order_factor
        pickup_orders = orders * (1 - delivery_share)
        delivery_orders = orders * delivery_share
        revenue = (
            500 * assumptions.subscription_sar
            + pickup_orders * assumptions.pickup_revenue_per_order_sar
            + delivery_orders
            * (assumptions.pickup_revenue_per_order_sar + assumptions.delivery_markup_sar)
        )
        direct_costs = (
            orders * assumptions.tokenization_cost_sar
            + orders * assumptions.sms_cost_per_order_sar
            + delivery_orders * assumptions.oto_variable_delivery_cost_sar
            + assumptions.oto_scale_plan_monthly_sar
            + base_foodics
        )
        return {
            "scenario": name,
            "orders": orders,
            "revenue_sar": revenue,
            "direct_costs_sar": direct_costs,
            "operating_profit_sar": revenue - direct_costs - base_opex,
        }

    slower_adds = [round(value * 0.7) for value in MONTHLY_NEW_MERCHANTS]
    slower_adds[-1] += 350 - sum(slower_adds)
    slower_rows = build_rows_with_additions(assumptions, slower_adds, OPERATING_EXPENSES)
    slower_totals = build_year_totals(slower_rows)

    return [
        case("Base case at 500 merchants", 1.00, assumptions.delivery_share),
        case("Order volume down 20%", 0.80, assumptions.delivery_share),
        case("Delivery mix falls to 25%", 1.00, 0.25),
        case("Delivery mix rises to 55%", 1.00, 0.55),
        {
            "scenario": "Slower merchant ramp to 350 by month 12",
            "orders": 0.0,
            "revenue_sar": slower_totals["revenue_sar"],
            "direct_costs_sar": slower_totals["direct_costs_sar"],
            "operating_profit_sar": slower_totals["operating_profit_sar"],
        },
    ]


def build_year_totals(rows: list[MonthlyRow]) -> dict[str, float]:
    return {
        "orders": sum(row.orders for row in rows),
        "gmv_sar": sum(row.gmv_sar for row in rows),
        "revenue_sar": sum(row.revenue_sar for row in rows),
        "direct_costs_sar": sum(row.direct_costs_sar for row in rows),
        "operating_expenses_sar": sum(row.operating_expenses_sar for row in rows),
        "operating_profit_sar": sum(row.operating_profit_sar for row in rows),
    }


def build_rows_with_additions(
    assumptions: Assumptions,
    additions: list[int],
    operating_expenses: list[float],
) -> list[MonthlyRow]:
    rows: list[MonthlyRow] = []
    current_merchants = 0
    previous_month_end = 0
    cumulative_profit = 0.0

    for index, new_merchants in enumerate(additions):
        current_merchants += new_merchants
        month_name = f"Month {index + 1}"
        average_subscribed = previous_month_end + (new_merchants * 0.5)

        order_equivalent_merchants = 0.0
        for cohort_index, cohort_size in enumerate(additions[: index + 1]):
            age = index - cohort_index
            order_equivalent_merchants += cohort_size * ramp_factor(age)

        orders = order_equivalent_merchants * assumptions.orders_per_merchant_per_month
        pickup_orders = orders * (1 - assumptions.delivery_share)
        delivery_orders = orders * assumptions.delivery_share
        gmv = orders * assumptions.average_order_value_sar

        revenue = (
            average_subscribed * assumptions.subscription_sar
            + pickup_orders * assumptions.pickup_revenue_per_order_sar
            + delivery_orders * assumptions.delivery_revenue_per_order_sar
        )

        direct_costs = (
            orders * assumptions.tokenization_cost_sar
            + orders * assumptions.sms_cost_per_order_sar
            + delivery_orders * assumptions.oto_variable_delivery_cost_sar
            + assumptions.oto_scale_plan_monthly_sar
            + foodics_cost_for_merchants(current_merchants, assumptions)
        )

        gross_profit = revenue - direct_costs
        operating_profit = gross_profit - operating_expenses[index]
        cumulative_profit += operating_profit

        rows.append(
            MonthlyRow(
                month=month_name,
                new_merchants=new_merchants,
                end_merchants=current_merchants,
                average_subscribed_merchants=average_subscribed,
                order_equivalent_merchants=order_equivalent_merchants,
                orders=orders,
                gmv_sar=gmv,
                revenue_sar=revenue,
                direct_costs_sar=direct_costs,
                gross_profit_sar=gross_profit,
                operating_expenses_sar=operating_expenses[index],
                operating_profit_sar=operating_profit,
                cumulative_profit_sar=cumulative_profit,
            )
        )

        previous_month_end = current_merchants

    return rows


def build_markdown_table(headers: list[str], rows: list[list[str]]) -> str:
    lines = [
        "| " + " | ".join(headers) + " |",
        "| " + " | ".join("---" for _ in headers) + " |",
    ]
    for row in rows:
        lines.append("| " + " | ".join(row) + " |")
    return "\n".join(lines)


def monthly_table(rows: list[MonthlyRow]) -> str:
    headers = [
        "Month",
        "End Merchants",
        "Orders",
        "Revenue (SAR)",
        "Direct Costs (SAR)",
        "Opex (SAR)",
        "Profit (SAR)",
    ]
    table_rows = [
        [
            row.month,
            str(row.end_merchants),
            f"{row.orders:,.0f}",
            money(row.revenue_sar),
            money(row.direct_costs_sar),
            money(row.operating_expenses_sar),
            money(row.operating_profit_sar),
        ]
        for row in rows
    ]
    return build_markdown_table(headers, table_rows)


def assumptions_table(assumptions: Assumptions) -> str:
    headers = ["Assumption", "Base Case", "Why it is reasonable"]
    rows = [
        [
            "Average order value",
            f"{assumptions.average_order_value_sar:.0f} SAR",
            "Balanced between cafe tickets and higher restaurant delivery baskets in Saudi Arabia.",
        ],
        [
            "Orders per merchant",
            f"{assumptions.orders_per_merchant_per_month:,}/month ({assumptions.orders_per_merchant_per_month / 30:.0f}/day)",
            "Suitable for branded merchant apps, not total POS volume.",
        ],
        [
            "Delivery mix",
            pct(assumptions.delivery_share),
            "Branded apps usually skew more to pickup than pure aggregator channels.",
        ],
        [
            "Monthly active customers",
            "340/merchant",
            "Implies roughly 1.6 orders per active customer each month.",
        ],
        [
            "New customers",
            f"{assumptions.new_customers_per_merchant_per_month}/merchant/month",
            "Keeps SMS cost low but not zero; realistic once repeat use starts compounding.",
        ],
        [
            "Payment mix",
            "50% Apple Pay on mada, 20% direct mada, 20% Apple Pay/card, 7% direct cards, 3% other",
            "Reflects Saudi mobile-wallet behavior while keeping mada dominant overall.",
        ],
        [
            "Merchant growth",
            "6 -> 500 net active merchants in 12 months",
            "Slow early sales, then faster growth from referrals, partnerships, and onboarding process maturity.",
        ],
        [
            "Order ramp after launch",
            "40% / 70% / 90% / 100%",
            "New merchants need time to get app downloads and repeat usage.",
        ],
    ]
    return build_markdown_table(headers, rows)


def payer_separation_table(assumptions: Assumptions) -> str:
    headers = ["Payer", "What they pay", "How it appears in the model"]
    rows = [
        [
            "Merchant",
            f"{assumptions.commission_rate * 100:.0f}% commission on order value and Moyasar percentage fees",
            "Your revenue captures the 1% commission; merchant-side PSP percentage fees are excluded from your cost base.",
        ],
        [
            "Customer",
            f"{assumptions.service_fee_sar:.0f} SAR service fee on every order and {assumptions.delivery_markup_sar:.0f} SAR extra on delivery orders",
            "These create the fixed order fee and delivery markup revenue lines.",
        ],
        [
            "Your company",
            f"{assumptions.tokenization_cost_sar:.2f} SAR tokenization, {assumptions.sms_auth_cost_sar:.1f} SAR per new-user auth, {assumptions.oto_variable_delivery_cost_sar:.1f} SAR per delivery, Foodics, OTO plan, payroll, infra, and sales overhead",
            "These appear in direct costs and operating expenses.",
        ],
    ]
    return build_markdown_table(headers, rows)


def unit_economics_table(assumptions: Assumptions) -> str:
    headers = ["Metric", "Pickup", "Delivery"]
    rows = [
        [
            "Revenue per order",
            f"{assumptions.pickup_revenue_per_order_sar:.3f} SAR",
            f"{assumptions.delivery_revenue_per_order_sar:.3f} SAR",
        ],
        [
            "Cost per order",
            f"{assumptions.pickup_cost_per_order_sar:.3f} SAR",
            f"{assumptions.delivery_cost_per_order_sar:.3f} SAR",
        ],
        [
            "Gross profit per order",
            f"{assumptions.pickup_revenue_per_order_sar - assumptions.pickup_cost_per_order_sar:.3f} SAR",
            f"{assumptions.delivery_revenue_per_order_sar - assumptions.delivery_cost_per_order_sar:.3f} SAR",
        ],
        [
            "Who pays gateway percentages",
            "Merchant",
            "Merchant",
        ],
        [
            "What you still pay",
            "0.05 SAR tokenization + SMS share",
            "0.05 SAR tokenization + SMS share + 0.5 SAR OTO variable fee",
        ],
    ]
    return build_markdown_table(headers, rows)


def per_merchant_table(assumptions: Assumptions, scale_snapshot: dict[str, float]) -> str:
    merchants = int(scale_snapshot["merchants"])
    pickup_orders = assumptions.orders_per_merchant_per_month * (1 - assumptions.delivery_share)
    delivery_orders = assumptions.orders_per_merchant_per_month * assumptions.delivery_share
    revenue = (
        assumptions.subscription_sar
        + pickup_orders * assumptions.pickup_revenue_per_order_sar
        + delivery_orders * assumptions.delivery_revenue_per_order_sar
    )
    direct_variable = (
        pickup_orders * assumptions.pickup_cost_per_order_sar
        + delivery_orders * assumptions.delivery_cost_per_order_sar
    )
    foodics_alloc = foodics_cost_for_merchants(merchants, assumptions) / merchants
    oto_alloc = assumptions.oto_scale_plan_monthly_sar / merchants
    opex_alloc = scale_snapshot["operating_expenses_sar"] / merchants
    net_profit = scale_snapshot["operating_profit_sar"] / merchants

    headers = ["Metric", "Per Merchant Per Month"]
    rows = [
        ["Subscription revenue", f"{assumptions.subscription_sar:.2f} SAR"],
        ["Order revenue", f"{revenue - assumptions.subscription_sar:.2f} SAR"],
        ["Total revenue", f"{revenue:.2f} SAR"],
        ["Direct variable costs", f"{direct_variable:.2f} SAR"],
        ["Allocated Foodics cost", f"{foodics_alloc:.2f} SAR"],
        ["Allocated OTO plan cost", f"{oto_alloc:.2f} SAR"],
        ["Allocated overhead", f"{opex_alloc:.2f} SAR"],
        ["Net operating profit", f"{net_profit:.2f} SAR"],
    ]
    return build_markdown_table(headers, rows)


def scale_table(scale_snapshot: dict[str, float]) -> str:
    headers = ["Metric", "500-Merchant Steady State"]
    rows = [
        ["Active merchants", f"{int(scale_snapshot['merchants'])}"],
        ["Orders per month", f"{scale_snapshot['orders']:,.0f}"],
        ["GMV per month", f"{money(scale_snapshot['gmv_sar'])} SAR"],
        ["Revenue per month", f"{money(scale_snapshot['revenue_sar'])} SAR"],
        ["Direct costs per month", f"{money(scale_snapshot['direct_costs_sar'])} SAR"],
        ["Gross profit per month", f"{money(scale_snapshot['gross_profit_sar'])} SAR"],
        ["Operating expenses per month", f"{money(scale_snapshot['operating_expenses_sar'])} SAR"],
        ["Operating profit per month", f"{money(scale_snapshot['operating_profit_sar'])} SAR"],
    ]
    return build_markdown_table(headers, rows)


def sensitivity_table(cases: list[dict[str, float | str]]) -> str:
    headers = ["Scenario", "Revenue (SAR)", "Direct Costs (SAR)", "Operating Profit (SAR)"]
    rows = [
        [
            str(case["scenario"]),
            money(float(case["revenue_sar"])),
            money(float(case["direct_costs_sar"])),
            money(float(case["operating_profit_sar"])),
        ]
        for case in cases
    ]
    return build_markdown_table(headers, rows)


def sources_section() -> str:
    return "\n".join(
        [
            "- Current payment implementation: `server/services/payment.ts` and `app/checkout.tsx`.",
            "- Current Foodics integration: `server/services/foodics.ts`.",
            "- Current OTO integration: `server/services/oto.ts`.",
            "- Build and deployment context: `eas.json` and `app.config.js`.",
            "- Moyasar pricing agreement supplied by the user: `C:/Users/8cupc/OneDrive/سطح المكتب/document_pdf (1).pdf`.",
            "- Public docs used for capability expansion: `https://developers.foodics.com/`, `https://docs.moyasar.com/`, and `https://tryoto.com/pricing/`.",
        ]
    )


def build_report(rows: list[MonthlyRow], scale_snapshot: dict[str, float], totals: dict[str, float]) -> str:
    cases = build_sensitivity_cases(ASSUMPTIONS)
    month_7 = rows[6]
    month_10 = rows[9]

    return f"""# SaaS Financial Model And Vendor Capability Map

This report is a VAT-inclusive management view because that is what was requested. For statutory accounting, VAT should normally be treated as pass-through rather than operating revenue or operating expense.

## Executive Summary
- Target outcome: reach `500` net active merchants by `Month 12`.
- Base-case year 1 revenue: `{money(totals['revenue_sar'])} SAR`.
- Base-case year 1 operating profit: `{money(totals['operating_profit_sar'])} SAR`.
- Base-case year 1 GMV processed through the platform: `{money(totals['gmv_sar'])} SAR`.
- Monthly operating profit turns positive in `{month_7.month}` and cumulative profit turns positive in `{month_10.month}`.
- At steady state (`500` mature merchants), monthly operating profit reaches `{money(scale_snapshot['operating_profit_sar'])} SAR`.

## Base-Case Assumptions
{assumptions_table(ASSUMPTIONS)}

## Unit Economics
{unit_economics_table(ASSUMPTIONS)}

### Payer Separation
{payer_separation_table(ASSUMPTIONS)}

Notes:
- The model assumes the merchant pays Mada and card percentage fees to Moyasar, not your company.
- The `1 SAR` fraud fee is treated as covered by your `1 SAR` service fee, per your instruction.
- The `0.05 SAR` tokenization fee is modeled as your cost on each successful order.
- OTO is modeled conservatively with both the fixed `399 SAR` Scale plan and your stated `0.5 SAR` delivery cost on delivery orders.

## Per-Merchant Monthly Economics
The table below uses a fully ramped merchant at the `500-merchant` scale point.

{per_merchant_table(ASSUMPTIONS, scale_snapshot)}

## Full Business Monthly Breakdown
{monthly_table(rows)}

## Year 1 Totals
| Metric | Year 1 Total |
| --- | --- |
| Orders | {totals['orders']:,.0f} |
| GMV | {money(totals['gmv_sar'])} SAR |
| Revenue | {money(totals['revenue_sar'])} SAR |
| Direct costs | {money(totals['direct_costs_sar'])} SAR |
| Operating expenses | {money(totals['operating_expenses_sar'])} SAR |
| Operating profit | {money(totals['operating_profit_sar'])} SAR |

## 500-Merchant Steady-State Snapshot
{scale_table(scale_snapshot)}

## Sensitivity Cases
{sensitivity_table(cases)}

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
{sources_section()}
"""


def write_csv(rows: list[MonthlyRow]) -> None:
    fieldnames = [
        "month",
        "new_merchants",
        "end_merchants",
        "average_subscribed_merchants",
        "order_equivalent_merchants",
        "orders",
        "gmv_sar",
        "revenue_sar",
        "direct_costs_sar",
        "gross_profit_sar",
        "operating_expenses_sar",
        "operating_profit_sar",
        "cumulative_profit_sar",
    ]
    with CSV_PATH.open("w", newline="", encoding="utf-8") as csv_file:
        writer = csv.DictWriter(csv_file, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            writer.writerow(
                {
                    "month": row.month,
                    "new_merchants": row.new_merchants,
                    "end_merchants": row.end_merchants,
                    "average_subscribed_merchants": f"{row.average_subscribed_merchants:.2f}",
                    "order_equivalent_merchants": f"{row.order_equivalent_merchants:.2f}",
                    "orders": f"{row.orders:.2f}",
                    "gmv_sar": f"{row.gmv_sar:.2f}",
                    "revenue_sar": f"{row.revenue_sar:.2f}",
                    "direct_costs_sar": f"{row.direct_costs_sar:.2f}",
                    "gross_profit_sar": f"{row.gross_profit_sar:.2f}",
                    "operating_expenses_sar": f"{row.operating_expenses_sar:.2f}",
                    "operating_profit_sar": f"{row.operating_profit_sar:.2f}",
                    "cumulative_profit_sar": f"{row.cumulative_profit_sar:.2f}",
                }
            )


def main() -> None:
    DOCS_DIR.mkdir(parents=True, exist_ok=True)
    rows = build_monthly_rows(ASSUMPTIONS)
    scale_snapshot = build_scale_snapshot(ASSUMPTIONS)
    totals = build_year_totals(rows)
    REPORT_PATH.write_text(build_report(rows, scale_snapshot, totals), encoding="utf-8")
    write_csv(rows)
    print(f"Wrote {REPORT_PATH.relative_to(ROOT)}")
    print(f"Wrote {CSV_PATH.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
