import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Operational drift detection, not a signature or malware attestation.
// Only source and dependency declarations; never .local, credentials or logs.
export function computeBuildIdentity(root) {
  const hash = createHash('sha256');
  const files = ['package.json', 'package-lock.json'];
  function walk(relative) {
    for (const item of readdirSync(join(root, relative), { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const name = `${relative}/${item.name}`;
      if (item.isDirectory()) walk(name);
      else if (item.isFile() && /\.(?:js|mjs|cjs|json)$/.test(item.name)) files.push(name);
    }
  }
  walk('src');
  for (const name of files.sort()) {
    const bytes = readFileSync(join(root, name));
    hash.update(`${name.length}:${name}:${bytes.length}:`);
    hash.update(bytes);
  }
  return hash.digest('hex');
}

// Captured once, so an old process cannot claim new disk code after a Git pull.
export const BUILD_ID = computeBuildIdentity(fileURLToPath(new URL('../', import.meta.url)));
