// Runs in the GH Actions Android build job before EAS Build kicks off.
// Mirrors what link-fcm-credentials.mjs does for the Expo side, but
// for the Firebase side: ensures the merchant's Android package is
// registered as an Android app in the nooks-push Firebase project,
// then refreshes the local google-services.json with the merged
// client list (so the AAB built right after this step has Firebase
// init for THIS merchant + every other merchant in the project).
//
// What it eliminates:
//   - Operator opening console.firebase.google.com per new merchant
//   - Operator clicking Add app → Android → typing package name
//   - Operator downloading the new google-services.json
//   - Operator committing the updated file to the repo
//
// Idempotent. If the merchant's package is already in the local
// google-services.json AND already registered in Firebase, it's a
// no-op (no API calls, no file write).
//
// Required env (provided by the workflow):
//   FCM_SA_JSON_PATH       Path to the decoded FCM/Firebase SA JSON
//   ANDROID_PACKAGE_ID     e.g. sa.nooks.<merchant-slug>
//   MERCHANT_SLUG          short identifier, used as displayName for
//                          the Firebase Android app
//
// Optional env:
//   FIREBASE_PROJECT_ID    defaults to the project_id field on the SA
//                          JSON itself (so a different Firebase
//                          project just means swapping the secret)
//
// Fail-open: any API/permission error logs a warning and exits 0 so
// the build still ships with the existing google-services.json.
// Operator can then fall back to the manual flow in
// docs/ANDROID_PUSH_SETUP.md.

import { createPrivateKey, createSign } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const FCM_SA_JSON_PATH = (process.env.FCM_SA_JSON_PATH || "").trim();
const ANDROID_PACKAGE_ID = (process.env.ANDROID_PACKAGE_ID || "").trim();
const MERCHANT_SLUG = (process.env.MERCHANT_SLUG || ANDROID_PACKAGE_ID || "merchant").trim();
const PROJECT_ID_OVERRIDE = (process.env.FIREBASE_PROJECT_ID || "").trim();

const GOOGLE_SERVICES_PATH = "./google-services.json";

if (!FCM_SA_JSON_PATH) {
  console.warn(
    "[fb-sync] FCM_SA_JSON_PATH is empty — skipping. Manual flow in docs/ANDROID_PUSH_SETUP.md still works."
  );
  process.exit(0);
}
if (!ANDROID_PACKAGE_ID) {
  console.warn("[fb-sync] ANDROID_PACKAGE_ID is empty — skipping.");
  process.exit(0);
}

let saJson;
try {
  saJson = JSON.parse(readFileSync(FCM_SA_JSON_PATH, "utf8"));
} catch (err) {
  console.warn(
    `[fb-sync] Couldn't read SA JSON at ${FCM_SA_JSON_PATH}: ${err?.message || err}. Skipping.`
  );
  process.exit(0);
}

const PROJECT_ID = (PROJECT_ID_OVERRIDE || saJson.project_id || "").trim();
if (!PROJECT_ID) {
  console.warn("[fb-sync] No project_id on SA JSON or env. Skipping.");
  process.exit(0);
}

// --- Fast path: skip everything if this package is already in the
// local google-services.json. Avoids a Firebase API call on every
// build (which is most builds, since most builds are for existing
// merchants whose package is already registered). ---
function clientsInLocalFile() {
  if (!existsSync(GOOGLE_SERVICES_PATH)) return null;
  try {
    const data = JSON.parse(readFileSync(GOOGLE_SERVICES_PATH, "utf8"));
    return (data.client || []).map(
      (c) => c?.client_info?.android_client_info?.package_name
    );
  } catch {
    return null;
  }
}

const localClients = clientsInLocalFile();
if (localClients && localClients.includes(ANDROID_PACKAGE_ID)) {
  console.log(
    `[fb-sync] ${ANDROID_PACKAGE_ID} already present in google-services.json — no-op.`
  );
  process.exit(0);
}

// --- Slow path: package missing locally, hit the API. ---

async function getAccessToken() {
  // Standard Google service-account JWT exchange. Same shape as ASC
  // auth except the audience + scopes target Google APIs. We need
  // both firebase + cloud-platform scopes so the SA can read+create
  // androidApps and read configs.
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT", kid: saJson.private_key_id };
  const payload = {
    iss: saJson.client_email,
    scope:
      "https://www.googleapis.com/auth/firebase https://www.googleapis.com/auth/cloud-platform",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 600,
    iat: now,
  };
  const enc = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  const data = `${enc(header)}.${enc(payload)}`;
  const key = createPrivateKey(saJson.private_key);
  const sig = createSign("RSA-SHA256").update(data).sign(key);
  const jwt = `${data}.${sig.toString("base64url")}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  const json = await res.json();
  if (!res.ok || !json.access_token) {
    throw new Error(
      `Token exchange failed (${res.status}): ${JSON.stringify(json).slice(0, 200)}`
    );
  }
  return json.access_token;
}

async function fb(path, init = {}, accessToken) {
  const res = await fetch(`https://firebase.googleapis.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`FB ${init.method ?? "GET"} ${path} -> ${res.status}: ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

async function pollOperation(opName, accessToken) {
  // androidApps.create returns an Operation. Poll until it's done.
  const start = Date.now();
  while (Date.now() - start < 60_000) {
    const op = await fb(`/v1beta1/${opName}`, {}, accessToken);
    if (op?.done) {
      if (op.error) {
        throw new Error(`Operation failed: ${JSON.stringify(op.error).slice(0, 200)}`);
      }
      return op.response;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`Operation ${opName} did not complete within 60 s`);
}

(async () => {
  console.log(
    `[fb-sync] Ensuring ${ANDROID_PACKAGE_ID} is registered in Firebase project ${PROJECT_ID}`
  );
  const accessToken = await getAccessToken();

  // 1. List existing Android apps in the project.
  const list = await fb(
    `/v1beta1/projects/${encodeURIComponent(PROJECT_ID)}/androidApps?pageSize=100`,
    {},
    accessToken
  );
  const apps = list?.apps ?? [];
  let target = apps.find((a) => a.packageName === ANDROID_PACKAGE_ID);

  if (!target) {
    console.log(
      `[fb-sync] Package not registered yet — creating Android app for ${ANDROID_PACKAGE_ID}`
    );
    const op = await fb(
      `/v1beta1/projects/${encodeURIComponent(PROJECT_ID)}/androidApps`,
      {
        method: "POST",
        body: JSON.stringify({
          packageName: ANDROID_PACKAGE_ID,
          displayName: `${MERCHANT_SLUG} Android`,
        }),
      },
      accessToken
    );

    // op.name is "operations/...". Poll until done; the response
    // contains the AndroidApp resource with appId.
    if (op?.name) {
      const result = await pollOperation(op.name, accessToken);
      target = result;
    } else if (op?.appId) {
      // Synchronous create response (some Firebase regions return
      // this without an Operation wrapper).
      target = op;
    } else {
      throw new Error(
        `Unexpected create response: ${JSON.stringify(op).slice(0, 200)}`
      );
    }
    console.log(`[fb-sync] Registered. appId=${target?.appId ?? "?"}`);
  } else {
    console.log(`[fb-sync] Already registered. appId=${target.appId}`);
  }

  // 2. Pull configs for EVERY app in the project so the merged file
  // we write contains all merchants — Firebase SDK on device picks
  // the right client by package_name.
  const refreshed = await fb(
    `/v1beta1/projects/${encodeURIComponent(PROJECT_ID)}/androidApps?pageSize=100`,
    {},
    accessToken
  );
  const allApps = refreshed?.apps ?? [];
  console.log(`[fb-sync] Building merged google-services.json with ${allApps.length} client(s).`);

  let merged = null;
  for (const app of allApps) {
    const cfg = await fb(
      `/v1beta1/projects/${encodeURIComponent(PROJECT_ID)}/androidApps/${encodeURIComponent(app.appId)}/config`,
      {},
      accessToken
    );
    if (!cfg?.configFileContents) {
      console.warn(`[fb-sync] No config for ${app.packageName} — skipping.`);
      continue;
    }
    const decoded = JSON.parse(
      Buffer.from(cfg.configFileContents, "base64").toString("utf8")
    );
    if (!merged) {
      // Use the first config as the base — its project_info section is
      // identical across all apps in the project.
      merged = { ...decoded, client: [] };
    }
    if (Array.isArray(decoded.client)) {
      merged.client.push(...decoded.client);
    }
  }

  if (!merged) {
    throw new Error("No client configs returned from Firebase");
  }

  // De-dupe by package_name in case Firebase ever returns
  // overlapping client entries.
  const seen = new Set();
  merged.client = merged.client.filter((c) => {
    const pkg = c?.client_info?.android_client_info?.package_name;
    if (!pkg || seen.has(pkg)) return false;
    seen.add(pkg);
    return true;
  });

  writeFileSync(GOOGLE_SERVICES_PATH, JSON.stringify(merged, null, 2));
  console.log(
    `[fb-sync] Wrote google-services.json with packages: ${[...seen].join(", ")}`
  );
})().catch((err) => {
  console.error("::warning::Firebase Android app sync failed:", err.message);
  console.error(
    "::warning::Falls back to existing google-services.json. Add the merchant's package manually at " +
      "https://console.firebase.google.com → nooks-push → Add app → Android, " +
      "then download google-services.json + commit (per docs/ANDROID_PUSH_SETUP.md)."
  );
  process.exit(0);
});
