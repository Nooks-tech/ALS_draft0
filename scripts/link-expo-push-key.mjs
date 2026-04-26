// Runs in the GH Actions iOS build job before EAS Build kicks off. Calls
// Expo's GraphQL API to:
//   1. Find or create an AppleAppIdentifier for the merchant's bundle id
//      under the team's Apple developer account record at Expo.
//   2. Find or create an IosAppCredentials record linking the Expo project
//      to that bundle, with the team's existing APNs auth key (.p8) as the
//      push key.
// After this runs once per bundle, Expo Push Service knows which APNs key
// to use when sending pushes to that bundle's tokens — so notifications
// from /dashboard/marketing actually reach the device instead of failing
// with InvalidCredentials.
//
// Idempotent: every subsequent build for the same bundle is a no-op.
//
// Required env:
//   BUNDLE_ID                  iOS bundle id (e.g. sa.nooks.khrtoom)
//   EXPO_TOKEN                 Expo personal/robot access token
//
// Optional env (defaults match the Nooks team):
//   EAS_PROJECT_ID             Expo App id (default: Nooks project)
//   EAS_ACCOUNT_ID             Expo Account id
//   APPLE_TEAM_IDENTIFIER      Apple team id (default: 4KUJ9DFZ8C)
//
// Skips silently if EXPO_TOKEN is missing — operator can still run
// `eas credentials` manually for the bundle.

const EAS_GRAPHQL = "https://api.expo.dev/graphql";

const BUNDLE_ID = (process.env.BUNDLE_ID ?? "").trim();
const EXPO_TOKEN = (process.env.EXPO_TOKEN ?? "").trim();
const EAS_PROJECT_ID = (
  process.env.EAS_PROJECT_ID ?? "23466554-dacc-421e-8642-efa95bbbcd7c"
).trim();
const EAS_ACCOUNT_ID = (
  process.env.EAS_ACCOUNT_ID ?? "7acc77f2-6646-463c-98a4-805334a12c7c"
).trim();
const APPLE_TEAM_IDENTIFIER = (
  process.env.APPLE_TEAM_IDENTIFIER ?? "4KUJ9DFZ8C"
).trim();

if (!BUNDLE_ID) {
  console.error("[push-link] BUNDLE_ID is empty — nothing to link");
  process.exit(0);
}
if (!EXPO_TOKEN) {
  console.warn(
    "[push-link] EXPO_TOKEN not set — skipping. Push notifications will fail until `eas credentials` is run manually for " +
      BUNDLE_ID
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
  console.log(`[push-link] Linking Expo push key for bundle: ${BUNDLE_ID}`);

  // Look up the Apple team Expo knows about, plus the team's existing
  // push keys and any bundles already registered.
  const teamData = await gql(
    `query($accountId: ID!, $teamId: String!) {
      appleTeam {
        byAppleTeamIdentifier(accountId: $accountId, identifier: $teamId) {
          id
          applePushKeys { id keyIdentifier }
          appleAppIdentifiers { id bundleIdentifier }
        }
      }
    }`,
    { accountId: EAS_ACCOUNT_ID, teamId: APPLE_TEAM_IDENTIFIER }
  );

  const team = teamData?.appleTeam?.byAppleTeamIdentifier;
  if (!team) {
    throw new Error(
      `Apple team ${APPLE_TEAM_IDENTIFIER} is not registered with Expo. ` +
        `Run \`eas credentials\` once locally to bootstrap, then this step will work.`
    );
  }
  if (!team.applePushKeys?.length) {
    throw new Error(
      `No APNs push key registered with Expo for team ${APPLE_TEAM_IDENTIFIER}. ` +
        `Create + upload one via \`eas credentials\` once, then this step will work.`
    );
  }

  // Use the first available push key — they're all team-scoped at Apple's
  // side anyway, so any of them works for any bundle on the team.
  const pushKey = team.applePushKeys[0];
  console.log(
    `[push-link] Push key: ${pushKey.keyIdentifier} (Expo id ${pushKey.id})`
  );

  // Find or create the AppleAppIdentifier record for this bundle.
  let appIdentifier = team.appleAppIdentifiers.find(
    (a) => a.bundleIdentifier === BUNDLE_ID
  );
  if (!appIdentifier) {
    console.log(`[push-link] Creating AppleAppIdentifier for ${BUNDLE_ID}`);
    const created = await gql(
      `mutation($input: AppleAppIdentifierInput!, $accountId: ID!) {
        appleAppIdentifier {
          createAppleAppIdentifier(
            appleAppIdentifierInput: $input,
            accountId: $accountId
          ) { id bundleIdentifier }
        }
      }`,
      {
        input: { bundleIdentifier: BUNDLE_ID, appleTeamId: team.id },
        accountId: EAS_ACCOUNT_ID,
      }
    );
    appIdentifier = created.appleAppIdentifier.createAppleAppIdentifier;
  }
  console.log(
    `[push-link] AppleAppIdentifier (Expo id): ${appIdentifier.id}`
  );

  // Check if iOS credentials already exist for this (project, bundle).
  const credsData = await gql(
    `query($appId: String!, $appleAppIdentifierId: String!) {
      app {
        byId(appId: $appId) {
          iosAppCredentials(filter: { appleAppIdentifierId: $appleAppIdentifierId }) {
            id
            pushKey { id keyIdentifier }
          }
        }
      }
    }`,
    { appId: EAS_PROJECT_ID, appleAppIdentifierId: appIdentifier.id }
  );
  const existingCreds = credsData?.app?.byId?.iosAppCredentials?.[0];

  if (existingCreds) {
    if (existingCreds.pushKey?.id === pushKey.id) {
      console.log(
        `[push-link] Already linked to push key ${pushKey.keyIdentifier} — no-op`
      );
      return;
    }
    console.log(
      `[push-link] iOS credentials exist (id ${existingCreds.id}) — re-linking push key`
    );
    await gql(
      `mutation($id: ID!, $pushKeyId: ID!) {
        iosAppCredentials {
          setPushKey(id: $id, pushKeyId: $pushKeyId) { id }
        }
      }`,
      { id: existingCreds.id, pushKeyId: pushKey.id }
    );
    console.log(`[push-link] Push key updated.`);
    return;
  }

  // Create new IosAppCredentials with the push key set in one mutation.
  console.log(`[push-link] Creating IosAppCredentials + linking push key`);
  await gql(
    `mutation($input: IosAppCredentialsInput!, $appId: ID!, $appleAppIdentifierId: ID!) {
      iosAppCredentials {
        createIosAppCredentials(
          iosAppCredentialsInput: $input,
          appId: $appId,
          appleAppIdentifierId: $appleAppIdentifierId
        ) { id }
      }
    }`,
    {
      input: { appleTeamId: team.id, pushKeyId: pushKey.id },
      appId: EAS_PROJECT_ID,
      appleAppIdentifierId: appIdentifier.id,
    }
  );
  console.log(
    `[push-link] Linked ${BUNDLE_ID} -> push key ${pushKey.keyIdentifier}`
  );
})().catch((err) => {
  // Don't fail the build — push setup can be done manually if this script
  // breaks. Log clearly so operator notices.
  console.error("::warning::Failed to auto-link Expo push key:", err.message);
  console.error(
    "::warning::Run `eas credentials` for " +
      BUNDLE_ID +
      " manually to set up push notifications."
  );
  process.exit(0);
});
