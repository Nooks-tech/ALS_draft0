// Runs inside the GitHub Actions iOS build job. Talks to App Store Connect
// API directly (using our Admin-role API key) to mint a fresh provisioning
// profile for the merchant's bundle id, signed by the team's existing
// distribution certificate.
//
// Then writes ./credentials.json so EAS Build (with credentialsSource:
// "local" in eas.json) signs the IPA with these files instead of fetching
// from EAS Servers and validating against Apple — that validation path is
// the one that fails non-interactively on CI.
//
// Inputs (env):
//   BUNDLE_ID                  merchant's iOS bundle id (e.g. sa.nooks.khrtoom)
//   P12_PASSWORD               password the .p12 was exported with
//   ASC_API_KEY_ID             ASC API key id (10 chars)
//   ASC_API_ISSUER_ID          ASC API issuer id (uuid)
//   ASC_API_KEY_PATH           path to the .p8 file on disk
//
// Reads:
//   ./.nooks-build/ios/dist-cert.p12             (decoded by workflow)
// Writes:
//   ./.nooks-build/ios/profile.mobileprovision   (fresh, this build)
//   ./credentials.json                           (paths + p12 password)

import { createPrivateKey, createSign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

function required(name) {
  const v = (process.env[name] ?? "").trim();
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

const BUNDLE_ID = required("BUNDLE_ID");
const P12_PASSWORD = required("P12_PASSWORD");
const ASC_API_KEY_ID = required("ASC_API_KEY_ID");
const ASC_API_ISSUER_ID = required("ASC_API_ISSUER_ID");
const ASC_API_KEY_PATH = required("ASC_API_KEY_PATH");

const P12_PATH = "./.nooks-build/ios/dist-cert.p12";
const PROFILE_PATH = "./.nooks-build/ios/profile.mobileprovision";
const CREDENTIALS_PATH = "./credentials.json";

const API = "https://api.appstoreconnect.apple.com";

function makeJWT() {
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
  // ASC requires raw r||s ECDSA; Node defaults to DER which Apple rejects.
  const sig = createSign("SHA256")
    .update(data)
    .sign({ key, dsaEncoding: "ieee-p1363" });
  return `${data}.${sig.toString("base64url")}`;
}

const TOKEN = makeJWT();

async function asc(path, init = {}) {
  const url = `${API}${path}`;
  const res = await fetch(url, {
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
    console.error(`[asc] ${init.method ?? "GET"} ${path} -> ${res.status}`);
    console.error(text);
    throw new Error(`ASC API ${res.status} on ${path}`);
  }
  return text ? JSON.parse(text) : null;
}

async function findBundleId() {
  const q = encodeURIComponent(BUNDLE_ID);
  const json = await asc(`/v1/bundleIds?filter[identifier]=${q}&limit=200`);
  const match = (json?.data ?? []).find(
    (b) => b?.attributes?.identifier === BUNDLE_ID
  );
  if (!match) {
    throw new Error(
      `Bundle ID '${BUNDLE_ID}' is not registered in App Store Connect. ` +
        `Register it in Apple Developer Portal -> Identifiers (App IDs) ` +
        `with Apple Pay capability + the merchant's Apple Pay Merchant ID ` +
        `before triggering the build.`
    );
  }
  return match;
}

async function findDistributionCert() {
  const json = await asc(`/v1/certificates?limit=200`);
  const all = json?.data ?? [];
  const now = Date.now();
  const distributionTypes = new Set(["DISTRIBUTION", "IOS_DISTRIBUTION"]);
  const valid = all.filter((c) => {
    const type = c?.attributes?.certificateType;
    const exp = c?.attributes?.expirationDate;
    return distributionTypes.has(type) && exp && Date.parse(exp) > now;
  });
  if (valid.length === 0) {
    throw new Error(
      "No valid Distribution certificate in App Store Connect. " +
        "Run scripts/setup-ios-distribution-cert.mjs locally to mint one " +
        "and add IOS_DIST_CERT_P12_BASE64 + IOS_DIST_CERT_P12_PASSWORD to " +
        "GitHub Secrets."
    );
  }
  valid.sort(
    (a, b) =>
      Date.parse(b.attributes.expirationDate) -
      Date.parse(a.attributes.expirationDate)
  );
  return valid[0];
}

async function createProfile(bundleResourceId, certResourceId) {
  const profileName = `Nooks ${BUNDLE_ID} ${Date.now()}`.slice(0, 100);
  const body = {
    data: {
      type: "profiles",
      attributes: { name: profileName, profileType: "IOS_APP_STORE" },
      relationships: {
        bundleId: { data: { type: "bundleIds", id: bundleResourceId } },
        certificates: {
          data: [{ type: "certificates", id: certResourceId }],
        },
      },
    },
  };
  return asc("/v1/profiles", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

(async () => {
  console.log(`[provision] Bundle: ${BUNDLE_ID}`);

  const bundle = await findBundleId();
  console.log(
    `[provision] Bundle resource: ${bundle.id} (${bundle.attributes?.name})`
  );

  const cert = await findDistributionCert();
  console.log(
    `[provision] Distribution cert: ${cert.attributes?.name} ` +
      `(id=${cert.id}, serial=${cert.attributes?.serialNumber}, ` +
      `expires=${cert.attributes?.expirationDate})`
  );

  const profile = await createProfile(bundle.id, cert.id);
  const content = profile?.data?.attributes?.profileContent;
  if (!content) {
    throw new Error("Profile created but profileContent missing in response.");
  }
  writeFileSync(PROFILE_PATH, Buffer.from(content, "base64"));
  console.log(`[provision] Wrote profile -> ${PROFILE_PATH}`);

  const creds = {
    ios: {
      provisioningProfilePath: PROFILE_PATH,
      distributionCertificate: {
        path: P12_PATH,
        password: P12_PASSWORD,
      },
    },
  };
  writeFileSync(CREDENTIALS_PATH, JSON.stringify(creds, null, 2));
  console.log(`[provision] Wrote credentials.json`);
})().catch((err) => {
  console.error("::error::iOS provisioning setup failed:", err.message);
  process.exit(1);
});
