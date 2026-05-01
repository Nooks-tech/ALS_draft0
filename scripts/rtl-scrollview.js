// Migrates padding from a ScrollView's className to its
// contentContainerStyle. Putting padding on the ScrollView itself
// (instead of the content container) is a known source of small
// horizontal drift in RTL — the cart was hit by it, and most of the
// More-tab modals are too.
//
// Match: <ScrollView className="..px-N py-N..">  (no contentContainerStyle yet)
// Rewrite:
//   <ScrollView
//     className="..(stripped px/py classes).."
//     contentContainerStyle={{ paddingHorizontal: <N*4>, paddingVertical: <N*4> }}
//   >
//
// Tailwind unit table: 1 = 4px, so px-5 = 20, px-6 = 24, etc.
const fs = require('fs');
const path = require('path');

const ROOTS = ['app'];
const EXTS = new Set(['.tsx']);
const SKIP = new Set(['node_modules', '.expo', 'scripts']);

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.isFile() && EXTS.has(path.extname(e.name))) out.push(full);
  }
}

const TW = (n) => Number(n) * 4;

// Match an opening ScrollView with className=".." that contains
// at least one px-/py-/p- class and NO contentContainerStyle prop.
// Captures: 1=tag opening prefix, 2=class string.
// We rebuild the class string with px/py removed and inject a
// contentContainerStyle line.
function rewriteScrollView(src) {
  let changed = 0;
  const out = src.replace(
    /<ScrollView([^>]*?)\bclassName="([^"]*)"([^>]*?)>/g,
    (full, pre, classes, post) => {
      // Skip if a contentContainerStyle is already present.
      if (/contentContainerStyle/.test(pre + post)) return full;
      // Skip if no px-/py-/p- in the class.
      if (!/(\b|^)(p|px|py|pt|pb)-\d/.test(classes)) return full;

      let pH = null;
      let pV = null;
      let pT = null;
      let pB = null;

      const stripped = classes
        .split(/\s+/)
        .filter((c) => {
          let m;
          if ((m = /^p-(\d+(?:\.\d+)?)$/.exec(c))) {
            pH = TW(m[1]);
            pV = TW(m[1]);
            return false;
          }
          if ((m = /^px-(\d+(?:\.\d+)?)$/.exec(c))) {
            pH = TW(m[1]);
            return false;
          }
          if ((m = /^py-(\d+(?:\.\d+)?)$/.exec(c))) {
            pV = TW(m[1]);
            return false;
          }
          if ((m = /^pt-(\d+(?:\.\d+)?)$/.exec(c))) {
            pT = TW(m[1]);
            return false;
          }
          if ((m = /^pb-(\d+(?:\.\d+)?)$/.exec(c))) {
            pB = TW(m[1]);
            return false;
          }
          return true;
        })
        .join(' ');

      const styleEntries = [];
      if (pH != null) styleEntries.push(`paddingHorizontal: ${pH}`);
      if (pV != null) styleEntries.push(`paddingVertical: ${pV}`);
      if (pT != null) styleEntries.push(`paddingTop: ${pT}`);
      if (pB != null) styleEntries.push(`paddingBottom: ${pB}`);
      if (styleEntries.length === 0) return full;

      const ccs = `contentContainerStyle={{ ${styleEntries.join(', ')} }}`;
      changed++;
      return `<ScrollView${pre}className="${stripped}" ${ccs}${post}>`;
    },
  );
  return { out, changed };
}

const files = [];
for (const r of ROOTS) if (fs.existsSync(r)) walk(r, files);

let totalChanges = 0;
let touched = 0;
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  const { out, changed } = rewriteScrollView(src);
  if (changed > 0) {
    fs.writeFileSync(f, out);
    touched++;
    totalChanges += changed;
    console.log(`  rewrote ${changed} ScrollView(s):`, f);
  }
}
console.log(`\n${totalChanges} ScrollViews migrated across ${touched} files.`);
