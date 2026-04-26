// One-time local setup. Mints a fresh iOS Distribution Certificate via
// App Store Connect API, packages it as a .p12, and prints the values to
// add as GitHub Secrets. After this runs once, every merchant build can
// reuse the resulting .p12 — only the per-merchant provisioning profile
// is created per build (by scripts/provision-ios-build.mjs in CI).
//
// Run from the project root with:
//   ASC_API_KEY_ID=...           (10-char ASC key id)
//   ASC_API_ISSUER_ID=...        (uuid)
//   ASC_API_KEY_PATH=...         (path to AuthKey_<id>.p8 on disk)
//     node scripts/setup-ios-distribution-cert.mjs
//
// Requires `openssl` on PATH. Git Bash on Windows ships it; macOS / Linux
// have it by default.

import { createPrivateKey, createSign, randomBytes } from "node:crypto";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function required(name) {
  const v = (process.env[name] ?? "").trim();
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

const KEY_ID = required("ASC_API_KEY_ID");
const ISSUER_ID = required("ASC_API_ISSUER_ID");
const KEY_PATH = required("ASC_API_KEY_PATH");

function makeJWT() {
  const header = { alg: "ES256", kid: KEY_ID, typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: ISSUER_ID,
    iat: now,
    exp: now + 600,
    aud: "appstoreconnect-v1",
  };
  const enc = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  const data = `${enc(header)}.${enc(payload)}`;
  const key = createPrivateKey(readFileSync(KEY_PATH));
  const sig = createSign("SHA256")
    .update(data)
    .sign({ key, dsaEncoding: "ieee-p1363" });
  return `${data}.${sig.toString("base64url")}`;
}

const TOKEN = makeJWT();

const tmp = mkdtempSync(join(tmpdir(), "nooks-cert-"));
console.log(`[setup] Temp dir: ${tmp}`);

try {
  console.log("[setup] Generating RSA private key (2048 bit)...");
  execSync(`openssl genrsa -out "${tmp}/key.pem" 2048`, { stdio: "inherit" });

  console.log("[setup] Generating CSR...");
  execSync(
    `openssl req -new -key "${tmp}/key.pem" -out "${tmp}/csr.pem" -subj "/CN=Nooks Distribution/O=Nooks/C=SA"`,
    { stdio: "inherit" }
  );

  // ASC API wants the CSR contents (sans PEM headers) as a single base64 string.
  const csrPem = readFileSync(`${tmp}/csr.pem`, "utf8");
  const csrB64 = csrPem
    .replace(/-----BEGIN[^-]+-----|-----END[^-]+-----/g, "")
    .replace(/\s+/g, "");

  console.log("[setup] Submitting CSR to App Store Connect...");
  const body = {
    data: {
      type: "certificates",
      attributes: {
        csrContent: csrB64,
        certificateType: "DISTRIBUTION",
      },
    },
  };
  const res = await fetch(
    "https://api.appstoreconnect.apple.com/v1/certificates",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    }
  );
  const text = await res.text();
  if (!res.ok) {
    console.error("[setup] ASC API error:", res.status);
    console.error(text);
    throw new Error(`ASC API ${res.status} on POST /v1/certificates`);
  }
  const json = JSON.parse(text);
  const certB64 = json?.data?.attributes?.certificateContent;
  if (!certB64) throw new Error("ASC API returned no certificateContent");
  const certId = json.data.id;
  console.log(`[setup] Cert created: id=${certId}`);

  // Decode DER -> PEM so openssl pkcs12 can consume it.
  writeFileSync(`${tmp}/cert.cer`, Buffer.from(certB64, "base64"));
  execSync(
    `openssl x509 -inform DER -in "${tmp}/cert.cer" -outform PEM -out "${tmp}/cert.pem"`,
    { stdio: "inherit" }
  );

  // Random password — kept only as a GitHub Secret, never reused.
  const password = randomBytes(16).toString("base64url");
  console.log("[setup] Bundling key + cert into .p12...");
  execSync(
    `openssl pkcs12 -export -out "${tmp}/cert.p12" -inkey "${tmp}/key.pem" -in "${tmp}/cert.pem" -password pass:${password}`,
    { stdio: "inherit" }
  );

  const p12B64 = readFileSync(`${tmp}/cert.p12`).toString("base64");

  const sep = "=".repeat(48);
  console.log("");
  console.log(sep);
  console.log("Add these as GitHub Secrets on Nooks-tech/ALS_draft0:");
  console.log("Repo -> Settings -> Secrets and variables -> Actions");
  console.log(sep);
  console.log("");
  console.log("Secret name:  IOS_DIST_CERT_P12_BASE64");
  console.log("Secret value:");
  console.log(p12B64);
  console.log("");
  console.log("Secret name:  IOS_DIST_CERT_P12_PASSWORD");
  console.log("Secret value:");
  console.log(password);
  console.log("");
  console.log(sep);
  console.log("Save these in 1Password / your secrets vault as well.");
  console.log("Apple does NOT let you re-download the private key. Lose");
  console.log("it and you have to revoke + regenerate from scratch.");
  console.log(sep);
} finally {
  // Wipe the temp dir even on error — the .p12 + private key live there.
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {}
}
