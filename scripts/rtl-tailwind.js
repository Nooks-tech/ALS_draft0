// Converts physical Tailwind directional classes to logical ones
// inside JSX className strings. Required because NativeWind's
// ml-/mr-/pl-/pr- compile to physical marginLeft/etc, which do
// NOT auto-flip when I18nManager.forceRTL is on. The logical
// equivalents (ms-, me-, ps-, pe-) flip on direction.
//
//   ml-N -> ms-N   (margin-inline-start, leading)
//   mr-N -> me-N   (margin-inline-end,   trailing)
//   pl-N -> ps-N
//   pr-N -> pe-N
//
// Negative margins (-ml-N, -mr-N) are rewritten to logical counterparts.
// Only touches className=".." and className={`..`}.
const fs = require('fs');
const path = require('path');

const ROOTS = ['app', 'src/components'];
const EXTS = new Set(['.tsx', '.ts']);
const SKIP = new Set(['node_modules', '.expo', '.git', 'dist', 'build', 'scripts']);

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.isFile() && EXTS.has(path.extname(e.name))) out.push(full);
  }
}

const REPLACEMENTS = [
  [/(\b|-)(ml)-(\d+(?:\.\d+)?)\b/g, '$1ms-$3'],
  [/(\b|-)(mr)-(\d+(?:\.\d+)?)\b/g, '$1me-$3'],
  [/(\b|-)(pl)-(\d+(?:\.\d+)?)\b/g, '$1ps-$3'],
  [/(\b|-)(pr)-(\d+(?:\.\d+)?)\b/g, '$1pe-$3'],
];

function rewriteClassName(match, classes) {
  let out = classes;
  for (const [re, repl] of REPLACEMENTS) {
    out = out.replace(re, repl);
  }
  return match.replace(classes, out);
}

const files = [];
for (const r of ROOTS) if (fs.existsSync(r)) walk(r, files);

let count = 0;
for (const file of files) {
  let src = fs.readFileSync(file, 'utf8');
  const before = src;

  // className="..."
  src = src.replace(/className="([^"]*)"/g, (m, classes) =>
    rewriteClassName(m, classes),
  );
  // className={`...`} — single-line backtick template (no expressions inside)
  src = src.replace(/className=\{`([^`{]*)`\}/g, (m, classes) =>
    rewriteClassName(m, classes),
  );

  if (src !== before) {
    fs.writeFileSync(file, src);
    count++;
    console.log('  rewrote:', file);
  }
}
console.log(`\n${count} files rewritten of ${files.length} scanned.`);
