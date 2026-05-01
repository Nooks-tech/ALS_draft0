/**
 * Strips the manual RTL flips that fight native I18nManager.forceRTL.
 *
 * Patterns rewritten:
 *   1. flexDirection: isArabic ? 'row-reverse' : 'row'   →  flexDirection: 'row'
 *   2. flexDirection: rowDirection                       →  flexDirection: 'row'
 *   3. flexDirection: isArabic ? 'row-reverse' : 'row' (inside style={{}}) →  removed
 *   4. marginLeft / paddingLeft  isArabic ? 0 : N        →  marginStart / paddingStart: N
 *   5. marginRight / paddingRight isArabic ? N : 0       →  marginStart / paddingStart: N
 *   6. marginLeft  isArabic ? N : 0                      →  marginEnd: N
 *   7. marginRight isArabic ? 0 : N                      →  marginEnd: N
 *   8. textAlign: isArabic ? 'right' : 'left'            →  removed (RN flips natively)
 *
 * The script is conservative — it only touches the patterns above
 * and leaves anything else alone. It also leaves intentional
 * direction-swaps for icon shape (BackIcon = isArabic ? ArrowRight :
 * ArrowLeft) untouched, since those are about the SVG, not layout.
 */
const fs = require('fs');
const path = require('path');

const ROOTS = ['app', 'src/components'];
const EXTS = new Set(['.tsx', '.ts']);
const SKIP_DIRS = new Set(['node_modules', '.expo', '.git', 'dist', 'build']);

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && EXTS.has(path.extname(entry.name))) out.push(full);
  }
}

const files = [];
for (const root of ROOTS) {
  if (fs.existsSync(root)) walk(root, files);
}

let totalChanged = 0;

for (const file of files) {
  let src = fs.readFileSync(file, 'utf8');
  const before = src;

  // 1+2: flexDirection: isArabic|rowDirection ternary → 'row'
  src = src.replace(
    /flexDirection:\s*isArabic\s*\?\s*['"]row-reverse['"]\s*:\s*['"]row['"]/g,
    "flexDirection: 'row'"
  );
  src = src.replace(
    /flexDirection:\s*rowDirection/g,
    "flexDirection: 'row'"
  );

  // 4. marginLeft: isArabic ? 0 : N  → marginStart: N
  src = src.replace(
    /marginLeft:\s*isArabic\s*\?\s*0\s*:\s*([0-9.]+)/g,
    'marginStart: $1'
  );
  // 5. marginRight: isArabic ? N : 0  → marginStart: N
  src = src.replace(
    /marginRight:\s*isArabic\s*\?\s*([0-9.]+)\s*:\s*0/g,
    'marginStart: $1'
  );
  // 6. marginLeft: isArabic ? N : 0  → marginEnd: N
  src = src.replace(
    /marginLeft:\s*isArabic\s*\?\s*([0-9.]+)\s*:\s*0/g,
    'marginEnd: $1'
  );
  // 7. marginRight: isArabic ? 0 : N  → marginEnd: N
  src = src.replace(
    /marginRight:\s*isArabic\s*\?\s*0\s*:\s*([0-9.]+)/g,
    'marginEnd: $1'
  );

  // Same for paddingLeft/paddingRight
  src = src.replace(
    /paddingLeft:\s*isArabic\s*\?\s*0\s*:\s*([0-9.]+)/g,
    'paddingStart: $1'
  );
  src = src.replace(
    /paddingRight:\s*isArabic\s*\?\s*([0-9.]+)\s*:\s*0/g,
    'paddingStart: $1'
  );
  src = src.replace(
    /paddingLeft:\s*isArabic\s*\?\s*([0-9.]+)\s*:\s*0/g,
    'paddingEnd: $1'
  );
  src = src.replace(
    /paddingRight:\s*isArabic\s*\?\s*0\s*:\s*([0-9.]+)/g,
    'paddingEnd: $1'
  );

  // Negative-margin variant (e.g. -8 for back-button hit slop):
  // marginLeft: isArabic ? 0 : -8  → marginStart: -8
  src = src.replace(
    /marginLeft:\s*isArabic\s*\?\s*0\s*:\s*(-[0-9.]+)/g,
    'marginStart: $1'
  );
  src = src.replace(
    /marginRight:\s*isArabic\s*\?\s*(-[0-9.]+)\s*:\s*0/g,
    'marginStart: $1'
  );
  src = src.replace(
    /marginLeft:\s*isArabic\s*\?\s*(-[0-9.]+)\s*:\s*0/g,
    'marginEnd: $1'
  );
  src = src.replace(
    /marginRight:\s*isArabic\s*\?\s*0\s*:\s*(-[0-9.]+)/g,
    'marginEnd: $1'
  );

  // 8. textAlign: isArabic ? 'right' : 'left'  → strip
  // Handle inside object literal (with trailing comma)
  src = src.replace(
    /\btextAlign:\s*isArabic\s*\?\s*['"]right['"]\s*:\s*['"]left['"]\s*,?\s*/g,
    ''
  );

  if (src !== before) {
    fs.writeFileSync(file, src);
    totalChanged++;
    console.log('  modified:', file);
  }
}

console.log(`\nDone. ${totalChanged} files modified out of ${files.length} scanned.`);
