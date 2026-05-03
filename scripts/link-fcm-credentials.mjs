// Runs in the GH Actions Android build job before EAS Build kicks off.
// Mirrors scripts/link-expo-push-key.mjs but for FCM v1 credentials:
//   1. Find or create a GoogleServiceAccountKey resource on Expo for
//      the Nooks account, by matching the SA JSON's private_key_id.
//   2. Find or create AndroidAppCredentials for the merchant's package.
//   3. Link the SA key as the FCM v1 sender for those credentials.
//
// After this runs once per Android package, Expo Push Service knows
// which Firebase project to use when sending pushes — so notifications
// from /dashboard/marketing actually reach Android devices instead of
// failing silently with "no FCM credentials configured."
//
// Idempotent: re-runs are no-ops if the link is already in place.
//
// Required env:
//   FCM_SA_JSON_PATH           Path to the decoded FCM v1 SA JSON file
//   ANDROID_PACKAGE_ID         e.g. sa.nooks.khrtoom
//   EXPO_TOKEN                 Expo personal/robot access token
//
// Optional env (defaults match Nooks):
//   EAS_PROJECT_ID             Expo App id
//   EAS_ACCOUNT_ID             Expo Account id
//
// Fail-open: any GraphQL/network error logs a warning and exits 0 so
// the build still ships. Operator can fall back to the manual upload
// described in docs/ANDROID_PUSH_SETUP.md.

import { readFileSync } from "node:fs";

const EAS_GRAPHQL = "https://api.expo.dev/graphql";

const FCM_SA_JSON_PATH = (process.env.FCM_SA_JSON_PATH || "").trim();
const ANDROID_PACKAGE_ID = (process.env.ANDROID_PACKAGE_ID || "").trim();
const EXPO_TOKEN = (process.env.EXPO_TOKEN || "").trim();
const EAS_PROJECT_ID = (
  process.env.EAS_PROJECT_ID || "23466554-dacc-421e-8642-efa95bbbcd7c"
).trim();
const EAS_ACCOUNT_ID = (
  process.env.EAS_ACCOUNT_ID || "7acc77f2-6646-463c-98a4-805334a12c7c"
).trim();

if (!ANDROID_PACKAGE_ID) {
  console.warn(
    "[fcm-link] ANDROID_PACKAGE_ID is empty — skipping. Set it on the workflow input."
  );
  process.exit(0);
}
if (!FCM_SA_JSON_PATH) {
  console.warn(
    "[fcm-link] FCM_SA_JSON_PATH is empty — skipping. " +
      "Set GOOGLE_FCM_SERVICE_ACCOUNT_JSON_BASE64 secret + decode step in workflow."
  );
  process.exit(0);
}
if (!EXPO_TOKEN) {
  console.warn(
    "[fcm-link] EXPO_TOKEN not set — skipping. Run `eas credentials` manually for " +
      ANDROID_PACKAGE_ID
  );
  process.exit(0);
}

let saJson;
try {
  saJson = JSON.parse(readFileSync(FCM_SA_JSON_PATH, "utf8"));
} catch (err) {
  console.warn(
    `[fcm-link] Failed to read FCM SA JSON at ${FCM_SA_JSON_PATH}: ${err?.message || err}. Skipping.`
  );
  process.exit(0);
}

const SA_PRIVATE_KEY_ID = (saJson.private_key_id || "").trim();
const SA_CLIENT_EMAIL = (saJson.client_email || "").trim();
if (!SA_PRIVATE_KEY_ID || !SA_CLIENT_EMAIL) {
  console.warn(
    "[fcm-link] FCM SA JSON missing private_key_id or client_email. Skipping."
  );
  process.exit(0);
}

async function gql(query, variables = {}) {
  const res = await fetch(EAS_GRAPHQL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${EXPO_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) {
    throw new Error(
      `EAS GraphQL: ${json.errors.map((e) => e.message).join("; ")}`
    );
  }
  return json.data;
}

(async () => {
  console.log(
    `[fcm-link] Linking FCM credentials for package: ${ANDROID_PACKAGE_ID}`
  );
  console.log(`[fcm-link] SA client_email: ${SA_CLIENT_EMAIL}`);
  console.log(`[fcm-link] SA private_key_id: ${SA_PRIVATE_KEY_ID}`);

  // Step 1: Look up existing GoogleServiceAccountKeys on the account.
  // We dedupe by privateKeyIdentifier so re-running this script doesn't
  // pile up duplicate keys on the Expo dashboard.
  const accountQuery = await gql(
    `query($accountId: ID!) {
      account {
        byId(accountId: $accountId) {
          id
          googleServiceAccountKeys {
            id
            clientEmail
            privateKeyIdentifier
          }
        }
      }
    }`,
    { accountId: EAS_ACCOUNT_ID }
  );

  const account = accountQuery?.account?.byId;
  if (!account) {
    throw new Error(
      `Expo account ${EAS_ACCOUNT_ID} not found — check EAS_ACCOUNT_ID.`
    );
  }

  let existingKey = (account.googleServiceAccountKeys || []).find(
    (k) =>
      k.privateKeyIdentifier === SA_PRIVATE_KEY_ID ||
      k.clientEmail === SA_CLIENT_EMAIL
  );

  if (existingKey) {
    console.log(
      `[fcm-link] Found existing SA key on Expo: ${existingKey.id} (${existingKey.clientEmail})`
    );
  } else {
    console.log("[fcm-link] No matching SA key on Expo — uploading.");
    const created = await gql(
      `mutation($accountId: ID!, $googleServiceAccountKeyInput: GoogleServiceAccountKeyInput!) {
        googleServiceAccountKey {
          createGoogleServiceAccountKey(
            accountId: $accountId,
            googleServiceAccountKeyInput: $googleServiceAccountKeyInput
          ) {
            id
            clientEmail
            privateKeyIdentifier
          }
        }
      }`,
      {
        accountId: EAS_ACCOUNT_ID,
        googleServiceAccountKeyInput: {
          // Expo expects the entire SA JSON as a string under keyJson.
          keyJson: JSON.stringify(saJson),
        },
      }
    );
    existingKey =
      created?.googleServiceAccountKey?.createGoogleServiceAccountKey;
    if (!existingKey) {
      throw new Error("createGoogleServiceAccountKey returned no data.");
    }
    console.log(`[fcm-link] Uploaded SA key: ${existingKey.id}`);
  }

  // Step 2: Find or create AndroidAppCredentials for the merchant's
  // package on the Nooks app project. The filter shape mirrors the
  // iosAppCredentials filter used in link-expo-push-key.mjs.
  const credsQuery = await gql(
    `query($appId: String!, $applicationIdentifier: String!) {
      app {
        byId(appId: $appId) {
          androidAppCredentials(filter: { applicationIdentifier: $applicationIdentifier }) {
            id
            applicationIdentifier
            googleServiceAccountKeyForFcmV1 { id }
          }
        }
      }
    }`,
    { appId: EAS_PROJECT_ID, applicationIdentifier: ANDROID_PACKAGE_ID }
  );

  let creds = credsQuery?.app?.byId?.androidAppCredentials?.[0];

  if (creds && creds.googleServiceAccountKeyForFcmV1?.id === existingKey.id) {
    console.log(
      `[fcm-link] Already linked: package ${ANDROID_PACKAGE_ID} -> SA key ${existingKey.id}. No-op.`
    );
    return;
  }

  if (!creds) {
    console.log(
      `[fcm-link] No AndroidAppCredentials for ${ANDROID_PACKAGE_ID} — creating.`
    );
    const createdCreds = await gql(
      `mutation($appId: ID!, $applicationIdentifier: String!) {
        androidAppCredentials {
          createAndroidAppCredentials(
            androidAppCredentialsInput: {},
            appId: $appId,
            applicationIdentifier: $applicationIdentifier
          ) {
            id
          }
        }
      }`,
      {
        appId: EAS_PROJECT_ID,
        applicationIdentifier: ANDROID_PACKAGE_ID,
      }
    );
    creds = createdCreds?.androidAppCredentials?.createAndroidAppCredentials;
    if (!creds?.id) {
      throw new Error("createAndroidAppCredentials returned no id.");
    }
    console.log(`[fcm-link] Created AndroidAppCredentials: ${creds.id}`);
  }

  // Step 3: Link the SA key as FCM v1 sender.
  console.log(
    `[fcm-link] Linking SA key ${existingKey.id} -> credentials ${creds.id}`
  );
  await gql(
    `mutation($id: ID!, $googleServiceAccountKeyId: ID!) {
      androidAppCredentials {
        setGoogleServiceAccountKeyForFcmV1(
          id: $id,
          googleServiceAccountKeyId: $googleServiceAccountKeyId
        ) {
          id
        }
      }
    }`,
    { id: creds.id, googleServiceAccountKeyId: existingKey.id }
  );
  console.log(
    `[fcm-link] Done. ${ANDROID_PACKAGE_ID} -> FCM SA ${SA_CLIENT_EMAIL}`
  );
})().catch((err) => {
  // Fail-open: never block the build over push-credential setup. The
  // operator can fall back to the manual upload flow documented in
  // docs/ANDROID_PUSH_SETUP.md.
  console.error("::warning::Failed to auto-link FCM credentials:", err.message);
  console.error(
    `::warning::Fall back to the manual upload at ` +
      `https://expo.dev/accounts/abdullah_alsaedi/projects/Nooks/credentials/android/${ANDROID_PACKAGE_ID}`
  );
  process.exit(0);
});
