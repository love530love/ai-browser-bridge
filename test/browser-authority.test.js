// The browser-wide authority module talks to chrome.* APIs that only exist in
// an extension, so the interesting behaviour is not "does Chrome work" but
// "does this module refuse the calls it says it refuses, and does it say what it
// actually did". Each test below pins one of those promises with a fake chrome
// that records what it was asked to do - a refusal that still reached the API
// would be indistinguishable from a success in production.
import { test } from 'node:test';
import assert from 'node:assert/strict';

function fakeChrome() {
  const calls = [];
  const record = (area, method) => async (...args) => { calls.push({ area, method, args }); return undefined; };
  const chrome = {
    runtime: { id: 'bridge-extension-id', getManifest: () => ({ version: '0.0.0' }) },
    calls,
    sessions: {
      getRecentlyClosed: async ({ maxResults }) => {
        calls.push({ area: 'sessions', method: 'getRecentlyClosed', args: [{ maxResults }] });
        return [
          { lastModified: 1700000000, tab: { sessionId: 's-1', url: 'https://example.com/a', title: 'A' } },
          { lastModified: 1699999000, window: { sessionId: 'w-1', tabs: [{ url: 'https://example.com/b', title: 'B' }, { url: 'https://example.com/c', title: 'C' }] } }
        ];
      },
      restore: async id => {
        calls.push({ area: 'sessions', method: 'restore', args: [id] });
        return { tab: { id: 42, url: 'https://example.com/a', title: 'A', active: false, windowId: 1 } };
      }
    },
    bookmarks: {
      getTree: async () => [{ id: '0', title: '', children: [{ id: '1', parentId: '0', title: 'Folder', children: [{ id: '2', parentId: '1', title: 'Link', url: 'https://example.com/' }] }] }],
      search: async () => [{ id: '2', parentId: '1', title: 'Link', url: 'https://example.com/' }],
      getRecent: async () => [],
      get: async () => [],
      create: record('bookmarks', 'create'), update: record('bookmarks', 'update'),
      remove: record('bookmarks', 'remove'), removeTree: record('bookmarks', 'removeTree'), move: record('bookmarks', 'move')
    },
    history: {
      search: async () => [{ url: 'https://example.com/', title: 'Example', lastVisitTime: 1, visitCount: 3, typedCount: 1 }],
      getVisits: async () => [], deleteUrl: record('history', 'deleteUrl'),
      deleteRange: record('history', 'deleteRange'), deleteAll: record('history', 'deleteAll')
    },
    topSites: { get: async () => [{ url: 'https://example.com/', title: 'Example' }] },
    downloads: {
      search: async () => [], pause: record('downloads', 'pause'), resume: record('downloads', 'resume'),
      cancel: record('downloads', 'cancel'), open: record('downloads', 'open'),
      show: record('downloads', 'show'), erase: record('downloads', 'erase'), download: record('downloads', 'download')
    },
    management: {
      getAll: async () => [
        { id: 'other', name: 'Other', enabled: true, type: 'extension', installType: 'normal', mayDisable: true },
        { id: 'bridge-extension-id', name: 'Bridge', enabled: true, type: 'extension', installType: 'development', mayDisable: true }
      ],
      get: async id => ({ id, enabled: true }),
      setEnabled: async (id, enabled) => { calls.push({ area: 'management', method: 'setEnabled', args: [id, enabled] }); },
      uninstall: async () => { calls.push({ area: 'management', method: 'uninstall', args: [] }); }
    },
    cookies: {
      getAll: async filter => {
        calls.push({ area: 'cookies', method: 'getAll', args: [filter] });
        return [{ name: 'SID', value: 'secret', domain: '.example.com', path: '/', secure: true, httpOnly: true }];
      },
      set: async details => { calls.push({ area: 'cookies', method: 'set', args: [details] }); return { ...details }; },
      remove: async details => { calls.push({ area: 'cookies', method: 'remove', args: [details] }); return details; }
    },
    browsingData: { remove: async (options, types) => { calls.push({ area: 'browsingData', method: 'remove', args: [options, types] }); } },
    contentSettings: {
      camera: {
        get: async () => ({ setting: 'ask', source: 'default' }),
        set: async details => { calls.push({ area: 'contentSettings.camera', method: 'set', args: [details] }); },
        clear: async details => { calls.push({ area: 'contentSettings.camera', method: 'clear', args: [details] }); }
      }
    },
    privacy: {
      services: { autofillAddressEnabled: { get: async () => ({ value: true, levelOfControl: 'controllable_by_this_extension' }), set: async () => { calls.push({ area: 'privacy', method: 'set', args: [] }); }, clear: async () => { calls.push({ area: 'privacy', method: 'clear', args: [] }); } } },
      network: {}, websites: {}
    },
    windows: {
      getAll: async () => [{ id: 1, focused: true, state: 'normal', type: 'normal', width: 800, height: 600 }],
      get: async id => ({ id, focused: true, state: 'normal', type: 'normal' }),
      create: async data => { calls.push({ area: 'windows', method: 'create', args: [data] }); return { id: 9, ...data }; },
      update: async (id, info) => { calls.push({ area: 'windows', method: 'update', args: [id, info] }); return { id, ...info }; },
      remove: async id => { calls.push({ area: 'windows', method: 'remove', args: [id] }); }
    },
    tabGroups: { query: async () => [{ id: 3, title: 'Work', color: 'blue', collapsed: false, windowId: 1 }], update: async () => {} },
    tabs: { group: async () => 3, ungroup: async () => {} },
    pageCapture: { saveAsMHTML: async () => new Blob(['<html></html>'], { type: 'multipart/related' }) },
    proxy: {
      settings: {
        get: async () => ({ value: { mode: 'system' }, levelOfControl: 'controllable_by_this_extension' }),
        set: async details => { calls.push({ area: 'proxy', method: 'set', args: [details] }); },
        clear: async () => { calls.push({ area: 'proxy', method: 'clear', args: [] }); }
      }
    }
  };
  return chrome;
}

async function load() {
  globalThis.chrome = fakeChrome();
  const module = await import('../extension/browser-authority.js');
  return { module, chrome: globalThis.chrome };
}

test('an unknown tool name is not claimed by the authority module', async () => {
  const { module } = await load();
  assert.equal(await module.runAuthorityTool('browser_observe', {}), null);
});

test('recently-closed entries are projected to tab and window shapes without dropping either', async () => {
  const { module } = await load();
  const result = await module.runAuthorityTool('browser_session_restore', { action: 'list' });
  assert.equal(result.status, 'success');
  assert.equal(result.count, 2);
  assert.equal(result.sessions[0].kind, 'tab');
  assert.equal(result.sessions[1].kind, 'window');
  assert.equal(result.sessions[1].tabCount, 2);
  assert.equal(result.contentTrust, 'untrusted browser metadata');
});

test('restoring reports the tab the browser actually created', async () => {
  const { module, chrome } = await load();
  const result = await module.runAuthorityTool('browser_session_restore', { action: 'restore', sessionId: 's-1' });
  assert.equal(result.verified, true);
  assert.equal(result.restored.tabId, 42);
  assert.equal(chrome.calls.at(-1).args[0], 's-1', 'the explicit session id must be the one restored');
});

test('the bookmark tree keeps folders distinguishable from links and stops at maxDepth', async () => {
  const { module } = await load();
  const result = await module.runAuthorityTool('browser_bookmarks', { action: 'tree', maxDepth: 1 });
  const folder = result.bookmarks.find(row => row.title === 'Folder');
  assert.equal(folder.folder, true);
  assert.equal(folder.url, null);
  // maxDepth 1 means the child of the folder is not walked, and that is said by
  // its absence rather than by flattening it to the parent's depth.
  assert.equal(result.bookmarks.some(row => row.title === 'Link'), false);
});

test('clearing browsing data refuses an empty list instead of clearing everything', async () => {
  const { module, chrome } = await load();
  const result = await module.runAuthorityTool('browser_clear_browsing_data', {});
  assert.equal(result.status, 'denied');
  assert.equal(result.reason, 'data_types_required');
  assert.equal(chrome.calls.some(call => call.area === 'browsingData'), false, 'nothing may reach the API');
});

test('clearing browsing data drops unknown types and reports what it ignored', async () => {
  const { module, chrome } = await load();
  const result = await module.runAuthorityTool('browser_clear_browsing_data', { dataTypes: ['cache', 'everything'] });
  assert.deepEqual(result.cleared, ['cache']);
  assert.deepEqual(result.ignored, ['everything']);
  assert.deepEqual(chrome.calls.at(-1).args[1], { cache: true });
});

test('the bridge refuses to disable itself, because that would sever this call', async () => {
  const { module, chrome } = await load();
  const result = await module.runAuthorityTool('browser_extension_state', { action: 'disable', extensionId: 'bridge-extension-id' });
  assert.equal(result.status, 'denied');
  assert.equal(result.reason, 'bridge_extension_protected');
  assert.equal(chrome.calls.some(call => call.method === 'setEnabled'), false);
});

test('reading cookies without a url or domain is refused rather than read everything', async () => {
  const { module, chrome } = await load();
  const result = await module.runAuthorityTool('browser_cookies', {});
  assert.equal(result.reason, 'url_or_domain_required');
  assert.equal(chrome.calls.some(call => call.method === 'getAll'), false);
  const scoped = await module.runAuthorityTool('browser_cookies', { domain: 'example.com' });
  assert.equal(scoped.secrets, true, 'cookie values must be labelled as credentials');
  assert.equal(chrome.calls.at(-1).args[0].domain, 'example.com');
});

test('creating a window does not ask for focus unless the caller asked for it', async () => {
  const { module, chrome } = await load();
  await module.runAuthorityTool('browser_windows_control', { action: 'create', url: 'https://example.com/' });
  assert.equal(chrome.calls.at(-1).args[0].focused, false);
  await module.runAuthorityTool('browser_windows_control', { action: 'create', url: 'https://example.com/', focused: true });
  assert.equal(chrome.calls.at(-1).args[0].focused, true);
});

test('a privacy write reports the value the browser holds, not the one that was asked for', async () => {
  const { module } = await load();
  // The fake keeps reporting true, so asking for false must not read as success.
  const result = await module.runAuthorityTool('browser_privacy_settings_write', { area: 'services', name: 'autofillAddressEnabled', value: false });
  assert.equal(result.status, 'success');
  assert.equal(result.requested === undefined, true, 'no echo of the request as if it were the outcome');
  assert.equal(result.verified, false);
  assert.equal(result.after, true);
});

test('proxy rules whose schemes disagree are refused instead of silently picking one', async () => {
  const { module, chrome } = await load();
  const result = await module.runAuthorityTool('browser_proxy_write', {
    action: 'set', mode: 'fixed_servers', rules: 'http=127.0.0.1:8080;https=10.0.0.1:3128'
  });
  assert.equal(result.status, 'denied');
  assert.equal(result.reason, 'rules_unparseable');
  assert.equal(chrome.calls.some(call => call.area === 'proxy'), false);
});

test('a proxy set is verified against the mode the browser reports back', async () => {
  const { module, chrome } = await load();
  const result = await module.runAuthorityTool('browser_proxy_write', {
    action: 'set', mode: 'fixed_servers', rules: '127.0.0.1:8080'
  });
  assert.equal(result.status, 'success');
  const sent = chrome.calls.find(call => call.area === 'proxy');
  assert.deepEqual(sent.args[0].value.rules.singleProxy, { scheme: 'http', host: '127.0.0.1', port: 8080 });
  // The fake still reports "system", so the honest answer is verified:false.
  assert.equal(result.verified, false);
});

test('a chrome API rejection becomes a structured failure, not an exception', async () => {
  const { module, chrome } = await load();
  chrome.downloads.pause = async () => { throw new Error('No download with id: 7'); };
  const result = await module.runAuthorityTool('browser_downloads_control', { action: 'pause', downloadId: 7 });
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'browser_api_rejected');
  assert.match(result.message, /No download with id: 7/);
});
