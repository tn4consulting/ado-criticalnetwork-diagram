#!/usr/bin/env node
/**
 * build.js
 * --------
 * Step 2 of the pipeline: bundles the split dev sources (src/index.html,
 * src/styles.css, src/app.js) plus a data file into a single, standalone
 * public/index.html that can be opened directly (file://, no server),
 * emailed/shared as one file, or published via GitHub Pages — same as the
 * original monolithic version, but now generated instead of hand-maintained.
 *
 *   fetch_epics.js  -->  epics.json  -->  build.js  -->  public/index.html
 *
 * USAGE
 *   node build.js                              # uses epics.json, writes public/index.html
 *   node build.js --data other.json --out dist/report.html
 *   npm run build
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(ROOT, 'src');

const GENERATED_BANNER = (dataName) => (
  '<!--\n'
  + '  GENERATED FILE — do not hand-edit.\n'
  + `  Source lives in src/index.html, src/styles.css, src/app.js and ${dataName}.\n`
  + '  Regenerate with: node build.js\n'
  + '-->\n'
);

function parseArgs(argv) {
  const args = { data: path.join(ROOT, 'epics.json'), out: path.join(ROOT, 'public', 'index.html') };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--data') args.data = path.resolve(argv[++i]);
    else if (a === '--out') args.out = path.resolve(argv[++i]);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(args.data)) {
    console.error(`Data file not found: ${args.data}\nRun fetch_epics.js first, or pass --data.`);
    process.exit(1);
  }

  let html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(SRC, 'styles.css'), 'utf8');
  const js = fs.readFileSync(path.join(SRC, 'app.js'), 'utf8');
  const data = JSON.parse(fs.readFileSync(args.data, 'utf8'));

  html = html.replace(
    '<link rel="stylesheet" href="styles.css">',
    `<style>\n${css}\n</style>`,
  );

  const embeddedDataScript = `<script>window.__EPICS_DATA__ = ${JSON.stringify(data)};</script>`;
  html = html.replace(
    '<script src="app.js"></script>',
    `${embeddedDataScript}\n<script>\n${js}\n</script>`,
  );

  html = html.replace('<!DOCTYPE html>\n', `<!DOCTYPE html>\n${GENERATED_BANNER(path.basename(args.data))}`);

  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, html);
  console.log(`Bundled ${(data.epics || []).length} epics from ${path.basename(args.data)} -> ${args.out}`);
}

main();
