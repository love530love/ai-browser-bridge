// Read-only inspection of an installed extension's published JS assets.
// Never reads Chrome cookies, storage, history, login data or user conversations.
import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';
const root = resolve(process.argv[2] || 'C:/Users/love/AppData/Local/Google/Chrome/User Data/Default/Extensions/jelniggicmclhfgnlapbkgfibmgelfnp/0.1.6_1');
const out = resolve('docs/research/autoglm-0.1.6');
mkdirSync(out, { recursive: true });
function walk(dir) { return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]); }
const files = walk(root);
const inventory = files.filter(f => /\.(?:js|json|html|map|ts|tsx)$/.test(f) && !f.includes('_metadata')).map(f => ({
  file: relative(root, f).replaceAll('\\', '/'), bytes: statSync(f).size,
  sha256: createHash('sha256').update(readFileSync(f)).digest('hex')
}));
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const needles = [
  ['A01', 'static/js/background.js', 'chrome.sidePanel', 'Side panel open/setOptions implementation'],
  ['A02', 'static/js/background.js', 'async dispatchMouseEvent', 'CDP mouse input wrapper'],
  ['A03', 'static/js/background.js', 'async dispatchKeyEvent', 'CDP keyboard input wrapper'],
  ['A04', 'static/js/background.js', 'async left_click_drag', 'Drag implementation'],
  ['A05', 'static/js/background.js', 'async pressKeyChord', 'Modifier/key combination implementation'],
  ['A06', 'static/js/background.js', 'async scrollWheel', 'Coordinate-based wheel input'],
  ['A07', 'static/js/background.js', 'e.shadowRoot.childNodes', 'Shadow DOM traversal branch'],
  ['A08', 'static/js/background.js', 'chrome.webNavigation.getAllFrames', 'Frame handling; adjacent branch is site-specific'],
  ['A09', 'static/js/background.js', '"select_dropdown_option"===N){', 'Dropdown action handler'],
  ['A10', 'static/js/background.js', '"upload_file"===N', 'Upload command routes to injected function'],
  ['A11', 'static/js/background.js', 'new File([m],d', 'DataTransfer file assignment implementation'],
  ['A12', 'static/js/background.js', 'chrome.downloads.download', 'Download start and completion/error handling'],
  ['A13', 'static/js/background.js', 'chrome.tabs.goBack', 'Back and forward navigation'],
  ['A14', 'static/js/background.js', 'i.createProperties={windowId:r.windowId}', 'Task tab grouping implementation'],
  ['A15', 'static/js/main.js', 'session_id:n,request_id:r,type:a,with_screen_info', 'Chat request includes session, page context, stream, files'],
  ['A16', 'static/js/main.js', 'const a=new TextDecoder;let s=', 'Stream consumption and cancellation branch'],
  ['A17', 'static/js/background.js', 'sensitiveStatus:!0', 'Sensitive-action handoff state, not proof of complete detection'],
  ['A18', 'static/js/background.js', 'task_status:"website_need_login"', 'Login-required task state'],
  ['A19', 'static/js/background.js', 'chrome.tts.speak', 'Text to speech implementation'],
  ['A20', 'static/js/main.js', 'planner:"/planner"', 'Remote chat/controller/planner/ocr/translation routes'],
  ['A21', 'static/js/main.js', 'https://autoglm-api.zhipuai.cn/agentdr/v1/assistant/upload-mix', 'Remote upload request, not local model implementation'],
  ['A22', 'static/js/background.js', 'document.readyState?', 'Page ready-state wait branch'],
  ['A23', 'static/js/background.js', 'mcpAgentWindowId:0,mcpAgentTabId:0,taskTabIdList', 'Task/tab/window/session bookkeeping'],
  ['A24', 'static/js/background.js', 'window.location.href.includes(".feishu.cn/wiki")', 'Site-specific editor compatibility code']
];
const evidence = needles.map(([id, file, needle, interpretation]) => {
  const s = readFileSync(join(root, file), 'utf8'); const offset = s.indexOf(needle);
  return { id, file, needle, found: offset >= 0, offsetUtf16: offset, line: offset < 0 ? null : s.slice(0, offset).split('\n').length,
    interpretation, excerpt: offset < 0 ? null : s.slice(Math.max(0, offset - 100), offset + 500) };
});
const summary = {
  generatedAt: new Date().toISOString(), root, extensionVersion: manifest.version,
  fileCount: files.length, sourceMapCount: files.filter(f => f.endsWith('.map')).length,
  originalTypeScriptCount: files.filter(f => /\.(ts|tsx)$/.test(f)).length,
  inspectedManifest: { permissions: manifest.permissions, host_permissions: manifest.host_permissions, commands: manifest.commands, background: manifest.background },
  promptNames: Object.keys(JSON.parse(readFileSync(join(root, 'prompts.json'), 'utf8'))),
  method: 'Static inspection of local published assets; not a runtime verification of AutoGLM capabilities.'
};
writeFileSync(join(out, 'inventory.json'), JSON.stringify({ ...summary, files: inventory }, null, 2));
writeFileSync(join(out, 'evidence.json'), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({ root, version: manifest.version, files: files.length, maps: summary.sourceMapCount, originalTypeScript: summary.originalTypeScriptCount, evidenceFound: evidence.filter(e => e.found).length, missing: evidence.filter(e => !e.found).map(e => e.id), output: out }, null, 2));
