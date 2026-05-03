#!/usr/bin/env node
// Loops over every active Nooks merchant and publishes a JS-only OTA
// update to that merchant's EAS Update channel. Reads merchant branding
// from Supabase (merchants + app_config tables) so each per-merchant
// bundle has the right env baked in — without this the broadcast bundle
// would be merchant-X env on every device, breaking N-1 merchants.
//
// Usage:
//   node scripts/broadcast-update.mjs --message "fix(push): ..." [--target all|<merchant_id>] [--platform all|ios|android]
//
// Required env (provided by the GitHub workflow):
//   SUPABASE_URL                    Supabase REST URL
//   SUPABASE_SERVICE_ROLE_KEY       Service-role key (admin DB access)
//   EXPO_TOKEN                      Authenticates eas-cli (set by
//                                   expo-github-action upstream; this
//                                   script doesn't read it directly)
//
// Optional env (passed through into per-merchant .env files):
//   SUPABASE_ANON_KEY, API_URL, NOOKS_API_BASE_URL, GOOGLE_MAPS_API_KEY
//
// Exit codes:
//   0  every targeted merchant updated successfully
//   1  one or more merchants failed (per-merchant status printed)
//   2  setup error (missing secrets, invalid args, no merchants found
//      when explicit merchant_id was passed, etc.)

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function required(name) {
  const v = (process.env[name] || "").trim();
  if (!v) {
    console.error(`::error::${name} env var is required`);
    process.exit(2);
  }
  return v;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next != null && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else {
      out[key] = "true";
    }
  }
  return out;
}

const SUPABASE_URL = required("SUPABASE_URL").replace(/\/$/, "");
const SUPABASE_SERVICE_ROLE_KEY = required("SUPABASE_SERVICE_ROLE_KEY");

const args = parseArgs(process.argv.slice(2));
const message = (args.message || "").trim();
if (!message) {
  console.error("::error::--message is required");
  process.exit(2);
}
const target = (args.target || "all").trim();
const platform = (args.platform || "all").trim();
if (!["all", "ios", "android"].includes(platform)) {
  console.error(
    `::error::--platform must be one of: all, ios, android (got "${platform}")`
  );
  process.exit(2);
}
if (target !== "all" && !UUID_RE.test(target)) {
  console.error(
    `::error::--target must be 'all' or a valid merchant UUID (got "${target}")`
  );
  process.exit(2);
}

async function fetchMerchants() {
  // PostgREST embed: pull every active merchant + their app_config in
  // a single round trip. The `select=id,...,app_config(*)` syntax uses
  // the foreign-key relation Supabase auto-detects from
  // app_config.merchant_id. If app_config has no row for a merchant
  // the array comes back empty — handled by flattenAppConfig().
  const filterTarget =
    target === "all" ? "" : `&id=eq.${encodeURIComponent(target)}`;
  const select =
    "select=id,cafe_name,status,app_config(app_name,logo_url,app_icon_url,app_icon_bg_color,launcher_icon_scale,primary_color,accent_color,background_color,menu_card_color,text_color,tab_text_color,moyasar_publishable_key,apple_pay_merchant_id,ios_bundle_id,android_package_id)";
  const url = `${SUPABASE_URL}/rest/v1/merchants?status=eq.active&${select}${filterTarget}`;

  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error(
      `::error::Supabase query failed (${res.status} ${res.statusText}): ${text}`
    );
    process.exit(2);
  }
  const data = await res.json();
  if (!Array.isArray(data)) {
    console.error("::error::Supabase returned non-array response:", data);
    process.exit(2);
  }
  return data;
}

function flattenAppConfig(merchant) {
  // Supabase REST returns embedded one-to-many relations as arrays
  // even when the relation is one-to-one in practice. Pick first or
  // empty.
  const cfg = Array.isArray(merchant.app_config)
    ? merchant.app_config[0]
    : merchant.app_config;
  return cfg || {};
}

function envLine(key, value) {
  // Don't quote — Expo's dotenv loader handles whitespace, but values
  // with newlines or `#` are not in our schema. If that ever changes,
  // switch to JSON.stringify here.
  return `${key}=${value == null ? "" : value}\n`;
}

function writeEnvFor(merchant) {
  const cfg = flattenAppConfig(merchant);
  const lines = [
    envLine("EXPO_PUBLIC_MERCHANT_ID", merchant.id),
    envLine(
      "EXPO_PUBLIC_APP_NAME",
      cfg.app_name || merchant.cafe_name || "Nooks App"
    ),
    envLine("EXPO_PUBLIC_LOGO_URL", cfg.logo_url || ""),
    envLine("EXPO_PUBLIC_PRIMARY_COLOR", cfg.primary_color || "#0D9488"),
    envLine("EXPO_PUBLIC_ACCENT_COLOR", cfg.accent_color || "#0D9488"),
    envLine(
      "EXPO_PUBLIC_BACKGROUND_COLOR",
      cfg.background_color || "#f5f5f4"
    ),
    envLine("EXPO_PUBLIC_MENU_CARD_COLOR", cfg.menu_card_color || "#f5f5f4"),
    envLine("EXPO_PUBLIC_TEXT_COLOR", cfg.text_color || "#1f2937"),
    envLine("EXPO_PUBLIC_TAB_TEXT_COLOR", cfg.tab_text_color || "#ffffff"),
    envLine(
      "EXPO_PUBLIC_APP_ICON_BG_COLOR",
      cfg.app_icon_bg_color || ""
    ),
    envLine(
      "EXPO_PUBLIC_LAUNCHER_ICON_SCALE",
      cfg.launcher_icon_scale != null ? String(cfg.launcher_icon_scale) : "70"
    ),
    envLine("EXPO_PUBLIC_SUPABASE_URL", process.env.SUPABASE_URL || ""),
    envLine(
      "EXPO_PUBLIC_SUPABASE_ANON_KEY",
      process.env.SUPABASE_ANON_KEY || ""
    ),
    envLine("EXPO_PUBLIC_API_URL", process.env.API_URL || ""),
    envLine(
      "EXPO_PUBLIC_NOOKS_API_BASE_URL",
      process.env.NOOKS_API_BASE_URL || ""
    ),
    envLine(
      "EXPO_PUBLIC_MOYASAR_PUBLISHABLE_KEY",
      cfg.moyasar_publishable_key || ""
    ),
    envLine(
      "EXPO_PUBLIC_APPLE_PAY_MERCHANT_ID",
      cfg.apple_pay_merchant_id || ""
    ),
    envLine(
      "EXPO_PUBLIC_IOS_BUNDLE_IDENTIFIER",
      cfg.ios_bundle_id || ""
    ),
    envLine("EXPO_PUBLIC_ANDROID_PACKAGE", cfg.android_package_id || ""),
  ];
  if (process.env.GOOGLE_MAPS_API_KEY) {
    lines.push(envLine("GOOGLE_MAPS_API_KEY", process.env.GOOGLE_MAPS_API_KEY));
  }
  writeFileSync(".env", lines.join(""));
}

function easUpdate(channel, msg, plat) {
  // Sequential per merchant. Each invocation re-bundles the JS using
  // the .env we just wrote, then uploads + tags the bundle on the
  // merchant's channel. ~30-90 s per merchant.
  const argv = [
    "update",
    "--channel",
    channel,
    "--message",
    msg,
    "--non-interactive",
  ];
  if (plat !== "all") {
    argv.push("--platform", plat);
  }
  const result = spawnSync("eas", argv, {
    stdio: "inherit",
    encoding: "utf8",
  });
  return result.status === 0;
}

(async () => {
  console.log(`[broadcast] target=${target} platform=${platform}`);
  console.log(`[broadcast] message: ${message}`);

  const merchants = await fetchMerchants();
  if (!merchants.length) {
    if (target === "all") {
      console.warn(
        "::warning::No active merchants found. Nothing to broadcast."
      );
      process.exit(0);
    }
    console.error(
      `::error::Merchant ${target} not found or not active. Aborting.`
    );
    process.exit(2);
  }

  console.log(`[broadcast] Found ${merchants.length} merchant(s):`);
  for (const m of merchants) {
    const cfg = flattenAppConfig(m);
    console.log(
      `  - ${m.id} (${cfg.app_name || m.cafe_name || "unnamed"})`
    );
  }

  const results = [];
  for (const m of merchants) {
    const cfg = flattenAppConfig(m);
    const name = cfg.app_name || m.cafe_name || m.id;
    console.log("\n========================================");
    console.log(`[broadcast] Updating ${name} (${m.id})`);
    console.log("========================================");
    try {
      writeEnvFor(m);
      const ok = easUpdate(m.id, message, platform);
      results.push({ id: m.id, name, ok, error: ok ? null : "eas update returned non-zero" });
    } catch (err) {
      console.error(`[broadcast] ${m.id} threw:`, err?.message || err);
      results.push({
        id: m.id,
        name,
        ok: false,
        error: err?.message || String(err),
      });
    }
  }

  console.log("\n========================================");
  console.log("[broadcast] Summary");
  console.log("========================================");
  let failed = 0;
  for (const r of results) {
    const icon = r.ok ? "[OK]" : "[FAIL]";
    console.log(`${icon} ${r.name} (${r.id})${r.error ? ` -- ${r.error}` : ""}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} succeeded`);

  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error("[broadcast] Fatal error:", err);
  process.exit(2);
});
