const fs = require('fs');
const path = require('path');

const files = [
  path.join(__dirname, '..', 'node_modules', 'passkit-generator', 'lib', 'cjs', 'Signature.js'),
  path.join(__dirname, '..', 'node_modules', 'passkit-generator', 'lib', 'esm', 'Signature.js'),
];

const FIND = 'decryptRsaPrivateKey(signerKey.toString("utf-8"), signerKeyPassphrase)';
const ESM_REPLACE = 'decryptRsaPrivateKey(signerKey.toString("utf-8"), signerKeyPassphrase) || forge.pki.privateKeyFromPem(signerKey.toString("utf-8"))';
const CJS_REPLACE = 'decryptRsaPrivateKey(signerKey.toString("utf-8"), signerKeyPassphrase) || node_forge_1.default.pki.privateKeyFromPem(signerKey.toString("utf-8"))';

for (const file of files) {
  if (!fs.existsSync(file)) continue;
  let content = fs.readFileSync(file, 'utf-8');
  if (content.includes('privateKeyFromPem(signerKey')) {
    console.log(`[patch-passkit-generator] Already patched: ${path.basename(file)}`);
    continue;
  }
  const isCjs = file.includes('cjs');
  content = content.replace(FIND, isCjs ? CJS_REPLACE : ESM_REPLACE);
  fs.writeFileSync(file, content, 'utf-8');
  console.log(`[patch-passkit-generator] Patched: ${path.basename(file)}`);
}
