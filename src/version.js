import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// package.json is the single source of truth. The version used to be hardcoded
// in src/server.js (twice) and src/mcp.js, and every bump missed at least one
// of them, so /status and the MCP handshake disagreed with the manifest.
const packageRoot = fileURLToPath(new URL('../', import.meta.url));
export const VERSION = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version;
