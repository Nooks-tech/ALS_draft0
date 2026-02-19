/**
 * Run from repo root: node scripts/setup-build-webhook.js
 * 1. Ensures server/.env exists (copies from .env.example if missing).
 * 2. Checks which build-webhook env vars are set.
 * 3. Prints exactly what tokens are needed and step-by-step how to get each one.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'server');
const ENV_EXAMPLE = path.join(SERVER, '.env.example');
const ENV_FILE = path.join(SERVER, '.env');

const BUILD_KEYS = ['GITHUB_TOKEN', 'GITHUB_REPO', 'GITHUB_BUILD_REF', 'BUILD_WEBHOOK_BASE_URL', 'BUILD_WEBHOOK_SECRET'];

function parseEnv(content) {
  const out = {};
  if (!content) return out;
  for (const line of content.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

function ensureEnv() {
  if (fs.existsSync(ENV_FILE)) return;
  if (!fs.existsSync(ENV_EXAMPLE)) {
    console.error('server/.env.example not found.');
    process.exit(1);
  }
  fs.copyFileSync(ENV_EXAMPLE, ENV_FILE);
  console.log('Created server/.env from server/.env.example. Fill the build-webhook variables below.\n');
}

function main() {
  console.log('--- Nooks build webhook setup ---\n');

  ensureEnv();

  const raw = fs.readFileSync(ENV_FILE, 'utf8');
  const env = parseEnv(raw);

  const missing = BUILD_KEYS.filter((k) => {
    const v = env[k];
    if (k === 'GITHUB_BUILD_REF' || k === 'BUILD_WEBHOOK_SECRET') return false; // optional
    return !v || v === 'your-username/ALS_draft0' || v === 'ghp_xxxx' || v.startsWith('your ');
  });
  const hasGitHub = !!(env.GITHUB_TOKEN && env.GITHUB_REPO && env.GITHUB_REPO !== 'your-username/ALS_draft0');

  if (hasGitHub && env.GITHUB_TOKEN !== 'ghp_xxxx') {
    console.log('Server build env: GITHUB_TOKEN and GITHUB_REPO are set. POST /build will work.\n');
  }

  console.log('--- What you need to provide (and exactly how to get each) ---\n');

  console.log('1. EXPO_TOKEN (GitHub Actions secret – required for EAS build in the workflow)');
  console.log('   How to get the token:');
  console.log('   • Open https://expo.dev and log in.');
  console.log('   • Click your profile (top right) → Account settings.');
  console.log('   • In the sidebar click "Access tokens" (or open https://expo.dev/settings/access-tokens).');
  console.log('   • Click "Create token". Name it e.g. "GitHub Actions". Create and copy the token (shown only once).');
  console.log('   Where to set it:');
  console.log('   • On GitHub: open this repo → Settings → Secrets and variables → Actions → New repository secret.');
  console.log('   • Name: EXPO_TOKEN. Value: paste the Expo token. Click Add secret.');
  console.log('   • Or in terminal (from repo root):  gh secret set EXPO_TOKEN   then paste the token when prompted.');
  console.log('');

  console.log('2. GITHUB_TOKEN (server/.env – so the server can trigger the workflow)');
  console.log('   How to get it:');
  console.log('   • Open https://github.com/settings/tokens (GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic)).');
  console.log('   • "Generate new token (classic)". Name it e.g. "ALS build webhook".');
  console.log('   • Under scopes, check "repo" (full control of private repositories). Generate token. Copy it.');
  console.log('   Where to set it: in server/.env add a line:  GITHUB_TOKEN=ghp_xxxxxxxxxxxx');
  console.log('');

  console.log('3. GITHUB_REPO (server/.env)');
  console.log('   Value: your repo as owner/name. Example: if the repo URL is github.com/abdul/ALS_draft0 then set  GITHUB_REPO=abdul/ALS_draft0');
  console.log('   Add in server/.env:  GITHUB_REPO=your-github-username/ALS_draft0');
  console.log('');

  console.log('4. BUILD_WEBHOOK_BASE_URL (server/.env – optional until you deploy)');
  console.log('   After you deploy the API (e.g. Railway, Render), set this to the public base URL of the API.');
  console.log('   Example:  BUILD_WEBHOOK_BASE_URL=https://als-api.railway.app');
  console.log('   This is used so GET /build can return the exact URL to give Nooks. If unset, GET /build still works but may use the request host.');
  console.log('');

  console.log('5. BUILD_WEBHOOK_SECRET (server/.env – optional)');
  console.log('   If you want Nooks to send a secret header: create a random string (e.g. run:  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))" ).');
  console.log('   Add in server/.env:  BUILD_WEBHOOK_SECRET=that_string');
  console.log('   Give the same string to Nooks and ask them to send it in the  x-nooks-secret  header on every POST /build.');
  console.log('');

  console.log('--- After everything is set ---');
  console.log('• Run this script again to confirm server/.env has GITHUB_TOKEN and GITHUB_REPO.');
  console.log('• Deploy the server. Then open in browser or curl:  GET https://YOUR_API_URL/build');
  console.log('• Send Nooks the  webhook_url  from that response as  BUILD_SERVICE_WEBHOOK_URL. If you set BUILD_WEBHOOK_SECRET, give them that value for the  x-nooks-secret  header.');
  console.log('');
}

main();
