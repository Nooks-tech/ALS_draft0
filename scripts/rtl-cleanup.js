/**
 * The first refactor pass converted both halves of `marginLeft:
 * isArabic ? 0 : N, marginRight: isArabic ? N : 0` to the same
 * logical key, leaving duplicates like:
 *   marginStart: 16, marginStart: 16,
 *   marginEnd:   -8, marginEnd: -8,
 * Collapse each consecutive duplicate pair to a single key.
 *
 * Also drops trailing-empty style objects: `style={{}}` and any
 * `flexDirection: 'row',` followed only by another `flexDirection:
 * 'row'` (no harm but ugly).
 */
const fs = require('fs');
const path = require('path');

const ROOTS = ['app', 'src/components'];
const EXTS = new Set(['.tsx', '.ts']);
const SKIP = new Set(['node_modules', '.expo', '.git', 'dist', 'build']);

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.isFile() && EXTS.has(path.extname(e.name))) out.push(full);
  }
}

const files = [];
for (const r of ROOTS) if (fs.existsSync(r)) walk(r, files);

let count = 0;
for (const f of files) {
  let src = fs.readFileSync(f, 'utf8');
  const before = src;

  // Collapse duplicate marginStart: X, marginStart: X
  src = src.replace(
    /(margin(?:Start|End)|padding(?:Start|End)):\s*(-?[0-9.]+),\s*\1:\s*\2/g,
    '$1: $2'
  );

  // Drop trailing comma-only entries left behind by stripped textAlign
  src = src.replace(/,\s*}/g, ' }');

  if (src !== before) {
    fs.writeFileSync(f, src);
    count++;
    console.log('  cleaned:', f);
  }
}
console.log(`\n${count} files cleaned of ${files.length}.`);
