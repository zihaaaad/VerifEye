/**
 * Mirrors forensics/ into docs/forensics/.
 *
 * GitHub Pages serves the site from docs/, and a page there cannot import from a
 * parent directory, so the engine genuinely has to exist twice on disk. Keeping the
 * copies in step by hand is how they drift, so this is the one writer: run
 * `npm run sync` after touching anything in forensics/.
 *
 * `npm run sync:check` is the same comparison in read-only mode. It runs as part of
 * `npm test`, so a stale mirror fails the suite instead of silently shipping a docs
 * page that behaves differently from the extension.
 */

import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'forensics');
const target = join(root, 'docs', 'forensics');

const checkOnly = process.argv.includes('--check');

const files = (await readdir(source)).filter(name => name.endsWith('.js')).sort();

await mkdir(target, { recursive: true });

const stale = [];
let copied = 0;

for (const name of files) {
    const from = await readFile(join(source, name), 'utf8');

    let to = null;
    try {
        to = await readFile(join(target, name), 'utf8');
    } catch {
        // Missing in the mirror counts as stale.
    }

    if (from === to) continue;

    stale.push(name);
    if (!checkOnly) {
        await writeFile(join(target, name), from);
        copied++;
    }
}

// A file that exists only in the mirror is also drift: it would be dead code the
// extension never loads, and nothing else would ever flag it.
const mirrored = (await readdir(target)).filter(name => name.endsWith('.js'));
const orphans = mirrored.filter(name => !files.includes(name));

if (checkOnly) {
    if (stale.length === 0 && orphans.length === 0) {
        console.log(`sync:check  docs/forensics is in step with forensics/ (${files.length} modules)`);
        process.exit(0);
    }
    if (stale.length) console.error(`sync:check  stale in docs/forensics: ${stale.join(', ')}`);
    if (orphans.length) console.error(`sync:check  orphaned in docs/forensics: ${orphans.join(', ')}`);
    console.error('sync:check  run `npm run sync` to update the mirror');
    process.exit(1);
}

for (const name of orphans) {
    console.warn(`sync  orphaned file left in place, delete by hand if unused: ${name}`);
}

console.log(copied === 0
    ? `sync  already in step (${files.length} modules)`
    : `sync  copied ${copied} module${copied === 1 ? '' : 's'} into docs/forensics: ${stale.join(', ')}`);
