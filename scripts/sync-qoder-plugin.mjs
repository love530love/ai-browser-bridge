import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PLUGIN = join(ROOT, 'qoder-plugin', 'ai-browser-bridge');
const SKILL_SRC = join(ROOT, 'skills', 'ai-browser-bridge');
const SKILL_DST = join(PLUGIN, 'skills', 'ai-browser-bridge');
const MANIFEST = join(PLUGIN, '.qoder-plugin', 'plugin.json');
const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const args = new Set(process.argv.slice(2));

function listFiles(dir, base = dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? listFiles(full, base) : [relative(base, full)];
  });
}

function check() {
  const failures = [];
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  if (manifest.version !== version) failures.push(`manifest version ${manifest.version} != package ${version}`);
  for (const key of ['skills', 'mcpServers']) {
    const declared = join(PLUGIN, manifest[key]);
    if (!existsSync(declared)) failures.push(`${key} path missing: ${manifest[key]}`);
  }
  const src = listFiles(SKILL_SRC).sort();
  const dst = existsSync(SKILL_DST) ? listFiles(SKILL_DST).sort() : [];
  if (src.join('|') !== dst.join('|')) failures.push('skill file list differs');
  for (const file of src) {
    const target = join(SKILL_DST, file);
    if (existsSync(target) && !readFileSync(join(SKILL_SRC, file)).equals(readFileSync(target))) {
      failures.push(`skill drift: ${file}`);
    }
  }
  if (failures.length) {
    console.error(`PLUGIN_CHECK_FAILED\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`PLUGIN_CHECK_OK version=${version} skillFiles=${src.length}`);
}

function sync() {
  mkdirSync(SKILL_DST, { recursive: true });
  cpSync(SKILL_SRC, SKILL_DST, { recursive: true });
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  manifest.version = version;
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`PLUGIN_SYNCED version=${version}`);
}

function zip() {
  check();
  const dist = join(ROOT, 'qoder-plugin', 'dist');
  mkdirSync(dist, { recursive: true });
  const out = join(dist, `ai-browser-bridge-${version}.zip`);
  if (process.platform === 'win32') {
    rmSync(out, { force: true });
    const q = (p) => `'${p.replace(/'/g, "''")}'`;
    const command = [
      'Add-Type -AssemblyName System.IO.Compression',
      'Add-Type -AssemblyName System.IO.Compression.FileSystem',
      `$zip = [IO.Compression.ZipFile]::Open(${q(out)}, [IO.Compression.ZipArchiveMode]::Create)`,
      `$src = ${q(PLUGIN)}`,
      'Get-ChildItem -LiteralPath $src -Recurse -File -Force | ForEach-Object { ' +
        '$rel = $_.FullName.Substring($src.Length + 1).Replace([char]92, [char]47); ' +
        '[IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $rel, [IO.Compression.CompressionLevel]::Optimal) | Out-Null }',
      '$zip.Dispose()'
    ].join('; ');
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], { stdio: 'inherit' });
  } else {
    rmSync(out, { force: true });
    execFileSync('zip', ['-qr', out, '.qoder-plugin', '.mcp.json', 'bin', 'skills', 'README.md'], { cwd: PLUGIN, stdio: 'inherit' });
  }
  const listCommand = process.platform === 'win32'
    ? `Add-Type -AssemblyName System.IO.Compression; Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::OpenRead(${`'${out.replace(/'/g, "''")}'`}).Entries | ForEach-Object { $_.FullName }`
    : null;
  const listing = process.platform === 'win32'
    ? execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', listCommand], { encoding: 'utf8' })
    : execFileSync('unzip', ['-Z1', out], { encoding: 'utf8' });
  const entries = listing.split(/\r?\n/).map((line) => line.trim().replace(/\\/g, '/'));
  if (!entries.includes('.qoder-plugin/plugin.json')) {
    console.error('PLUGIN_ZIP_INVALID: .qoder-plugin/plugin.json is not at the archive root');
    process.exit(1);
  }
  console.log(`PLUGIN_ZIP ${out}`);
}

if (args.has('--check')) check();
else if (args.has('--zip')) zip();
else sync();
