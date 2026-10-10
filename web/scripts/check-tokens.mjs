/*
 * Every var(--x) the app uses is actually defined.
 *
 * A missing custom property fails SILENTLY: the declaration is dropped and the element renders with
 * whatever it inherited, which usually looks plausible. Three invented names got through in the first
 * hour of this project - --bg, --accent and --play - and none of them looked broken on screen.
 *
 * Run with: node scripts/check-tokens.mjs
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

function walk(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const files = walk(src);
const text = files.map((f) => readFileSync(f, 'utf8')).join('\n');

// Declared anywhere - tokens.css (generated from the iOS app) or global.css (the semantic layer).
const declared = new Set([...text.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
const problems = [];

for (const file of files.filter((f) => f.endsWith('.css') || f.endsWith('.tsx'))) {
  const contents = readFileSync(file, 'utf8');
  for (const match of contents.matchAll(/var\((--[\w-]+)/g)) {
    // A var() with its own fallback is deliberate, so it is not a missing token.
    if (!declared.has(match[1]) && !contents.includes(`var(${match[1]},`)) {
      problems.push(`${file.slice(src.length + 1)} uses var(${match[1]}), which nothing defines`);
    }
  }
}

if (problems.length) {
  console.error(`${problems.length} undefined design token(s):`);
  for (const problem of [...new Set(problems)]) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(`design tokens ok - ${declared.size} defined`);
