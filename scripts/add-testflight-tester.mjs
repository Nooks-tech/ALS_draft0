// Runs in the GH Actions iOS build job after `eas submit` succeeds.
// Calls App Store Connect API to:
//   1. Find or create a beta group named "<slug>-testers" for the
//      merchant's app (one group per merchant, never shared).
//   2. Add the merchant's Apple ID as an external tester linked to
//      that beta group. Apple auto-sends the invitation email.
//
// "External" tester here means anyone with an Apple ID — they don't
// need to be on the App Store Connect team. (Internal testers DO
// require team membership which we can't safely automate.)
//
// Idempotent: re-running for the same email is a no-op.
//
// Required env:
//   APPLE_ID                   merchant's Apple ID email (operator's
//                              login for App Store / TestFlight)
//   BUNDLE_ID                  iOS bundle id (e.g. sa.nooks.khrtoom)
//   MERCHANT_SLUG              short identifier used for beta group
//                              name; falls back to the bundle id if
//                              empty
//   ASC_API_KEY_ID             ASC API key id (10 chars)
//   ASC_API_ISSUER_ID          ASC API issuer id (uuid)
//   ASC_API_KEY_PATH           path to the .p8 file on disk
//
// Skips silently if APPLE_ID is empty (operator opted out of the
// optional auto-invite).
//
// Fail-open: any ASC API error logs a warning and exits 0 so the
// build/submit still succeeds. Operator can add the tester manually
// from App Store Connect if this breaks.

import { createPrivateKey, createSign } from "node:crypto";
import { readFileSync } from "node:fs";

const APPLE_ID = (process.env.APPLE_ID || "").trim();
const BUNDLE_ID = (process.env.BUNDLE_ID || "").trim();
const MERCHANT_SLUG = (process.env.MERCHANT_SLUG || "").trim() || BUNDLE_ID;
const ASC_API_KEY_ID = (process.env.ASC_API_KEY_ID || "").trim();
const ASC_API_ISSUER_ID = (process.env.ASC_API_ISSUER_ID || "").trim();
const ASC_API_KEY_PATH = (process.env.ASC_API_KEY_PATH || "").trim();

if (!APPLE_ID) {
  console.log("[tf-tester] No APPLE_ID input — skipping.");
  process.exit(0);
}
if (!BUNDLE_ID || !ASC_API_KEY_ID || !ASC_API_ISSUER_ID || !ASC_API_KEY_PATH) {
  console.warn(
    "[tf-tester] Missing one of BUNDLE_ID / ASC_API_KEY_ID / ASC_API_ISSUER_ID / ASC_API_KEY_PATH — skipping."
  );
  process.exit(0);
}

const API = "https://api.appstoreconnect.apple.com";

function makeJWT() {
  // ASC requires raw r||s ECDSA (ieee-p1363); Node defaults to DER
  // which Apple rejects. Same approach used by provision-ios-build.mjs.
  const header = { alg: "ES256", kid: ASC_API_KEY_ID, typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: ASC_API_ISSUER_ID,
    iat: now,
    exp: now + 600,
    aud: "appstoreconnect-v1",
  };
  const enc = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  const data = `${enc(header)}.${enc(payload)}`;
  const key = createPrivateKey(readFileSync(ASC_API_KEY_PATH));
  const sig = createSign("SHA256")
    .update(data)
    .sign({ key, dsaEncoding: "ieee-p1363" });
  return `${data}.${sig.toString("base64url")}`;
}

const TOKEN = makeJWT();

async function asc(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `ASC ${init.method ?? "GET"} ${path} -> ${res.status}: ${text}`
    );
  }
  return text ? JSON.parse(text) : null;
}

(async () => {
  console.log(`[tf-tester] Auto-inviting ${APPLE_ID} to ${BUNDLE_ID}`);

  // 1. Find the app by bundle id.
  const appQ = encodeURIComponent(BUNDLE_ID);
  const apps = await asc(`/v1/apps?filter[bundleId]=${appQ}&limit=5`);
  const app = (apps?.data ?? []).find(
    (a) => a?.attributes?.bundleId === BUNDLE_ID
  );
  if (!app) {
    throw new Error(
      `App with bundleId '${BUNDLE_ID}' not found in App Store Connect.`
    );
  }
  console.log(`[tf-tester] App: ${app.id} (${app.attributes?.name})`);

  // 2. Find or create a beta group for this merchant.
  //
  // ASC API note: /v1/apps/{id}/betaGroups (the relationship
  // sub-resource) rejects filter[name] with a 400
  // PARAMETER_ERROR.ILLEGAL. The top-level /v1/betaGroups endpoint
  // DOES accept both filter[app] and filter[name] together — same
  // result, supported parameters. Use that.
  const groupName = `${MERCHANT_SLUG} testers`.slice(0, 50);
  const existingGroups = await asc(
    `/v1/betaGroups?filter[app]=${encodeURIComponent(app.id)}&filter[name]=${encodeURIComponent(groupName)}&limit=10`
  );
  let group = (existingGroups?.data ?? []).find(
    (g) => g.attributes?.name === groupName
  );

  if (!group) {
    console.log(`[tf-tester] Creating beta group: "${groupName}"`);
    const created = await asc("/v1/betaGroups", {
      method: "POST",
      body: JSON.stringify({
        data: {
          type: "betaGroups",
          attributes: {
            name: groupName,
            // Public link disabled — only invited testers can join.
            // Apple's default is fine; we don't need a shareable link.
          },
          relationships: {
            app: { data: { type: "apps", id: app.id } },
          },
        },
      }),
    });
    group = created?.data;
    if (!group?.id) throw new Error("createBetaGroup returned no data.");
  }
  console.log(`[tf-tester] Group: ${group.id} (${group.attributes?.name})`);

  // 3. Check if this email is already a tester in the group.
  //
  // ASC API note: same gotcha as the betaGroups lookup above —
  // /v1/betaGroups/{id}/betaTesters (the relationship sub-resource)
  // rejects filter[email] with a 400 PARAMETER_ERROR.ILLEGAL ("The
  // parameter 'filter[email]' can not be used with this request").
  // The top-level /v1/betaTesters endpoint DOES accept both
  // filter[betaGroups] and filter[email] together — same query,
  // supported parameters. Use that.
  const existingTesters = await asc(
    `/v1/betaTesters?filter[betaGroups]=${encodeURIComponent(group.id)}&filter[email]=${encodeURIComponent(APPLE_ID)}&limit=10`
  );
  const alreadyAdded = (existingTesters?.data ?? []).some(
    (t) => (t.attributes?.email || "").toLowerCase() === APPLE_ID.toLowerCase()
  );

  if (alreadyAdded) {
    console.log(
      `[tf-tester] ${APPLE_ID} is already a tester in this group — no-op.`
    );
    return;
  }

  // 4. Add the tester. Apple sends the invitation email automatically.
  console.log(`[tf-tester] Adding ${APPLE_ID} as external tester`);
  await asc("/v1/betaTesters", {
    method: "POST",
    body: JSON.stringify({
      data: {
        type: "betaTesters",
        attributes: {
          email: APPLE_ID,
          // firstName/lastName required by Apple even if blank-ish.
          firstName: "Merchant",
          lastName: "Operator",
        },
        relationships: {
          betaGroups: {
            data: [{ type: "betaGroups", id: group.id }],
          },
        },
      },
    }),
  });
  console.log(
    `[tf-tester] Done. Apple will email ${APPLE_ID} a TestFlight invite.`
  );
})().catch((err) => {
  // Fail-open: never block the build/submit over invite automation.
  console.error("::warning::Failed to auto-invite TestFlight tester:", err.message);
  console.error(
    `::warning::Add the tester manually at ` +
      `https://appstoreconnect.apple.com/apps`
  );
  process.exit(0);
});
