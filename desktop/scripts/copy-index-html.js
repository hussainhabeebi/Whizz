// index.html has exactly one source of truth — the repo root. This copies it into dist/
// at build time rather than keeping a second, divergence-prone copy checked into desktop/.
// Note: this is the raw static file, without the two small things worker/index.js injects
// at serve time (an inline <script> that reformats the leads table, and a periodic
// /js/auto-refresh.js tick) — both are cosmetic/legacy and superseded here by the desktop
// app's own sync loop, so skipping them is intentional, not an oversight.
const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..', '..');
const distDir = path.join(__dirname, '..', 'dist');

fs.mkdirSync(distDir, { recursive: true });
fs.copyFileSync(path.join(repoRoot, 'index.html'), path.join(distDir, 'index.html'));
// index.html links to this standalone page — copy it too so that link doesn't 404 locally.
// Lead Intelligence itself is online-only regardless (see syncableResources.js), so this is
// just about the link resolving, not about it working offline.
if (fs.existsSync(path.join(repoRoot, 'lead-intelligence.html'))) {
  fs.copyFileSync(path.join(repoRoot, 'lead-intelligence.html'), path.join(distDir, 'lead-intelligence.html'));
}

// index.html references a handful of same-origin static assets directly — copy whatever
// exists so they resolve the same way they do against the real hosted site.
for (const dir of ['js', 'css']) {
  const src = path.join(repoRoot, dir);
  const dest = path.join(distDir, dir);
  if (fs.existsSync(src)) {
    fs.rmSync(dest, { recursive: true, force: true });
    fs.cpSync(src, dest, { recursive: true });
  }
}

console.log('[whizz-desktop] copied index.html (+ js/css) into desktop/dist/');
