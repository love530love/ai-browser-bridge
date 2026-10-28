// Browser-wide authority: the chrome.* surfaces a human engineer reaches through
// the browser's own UI - the extension manager, the history page, the download
// shelf, the site-settings dialog, the recently-closed list, the bookmark
// manager, the tab strip and the window frame.
//
// These are deliberately separate from the page domain. A page tool is
// authorised by the tab's origin, and every one of them can be reasoned about by
// looking at one document. Nothing here has that property: deleting history,
// clearing cookies or disabling an extension is authorised by the user having
// connected this extension at all. So two rules hold for every handler below:
//
//   1. Writes are gated upstream. The service refuses a write unless the caller
//      echoed the exact confirmation string from src/confirmations.js. This
//      module never decides that a write is allowed; it only performs it.
//   2. Reads mark their payload. Bookmark titles, history URLs, extension names
//      and download filenames are attacker-influenced text that arrives from
//      outside the browser. Every response says so instead of letting a caller
//      treat it as instructions.
//
// Read and write live in different tools on purpose. A single tool with an
// `action` that sometimes needs a confirmation string trains callers to pass the
// string unconditionally, which is the same as having no gate.

const UNTRUSTED = 'untrusted browser metadata';

// A stable envelope, so a caller can tell "the browser said no" from "the
// bridge could not ask". Chrome rejects these calls with its own wording
// ("Invalid value for argument 1", "No tab with id: 5"), which is accurate but
// not actionable; the reason code is what a caller branches on.
function failed(name, error, extra = {}) {
  return {
    status: 'failed', retryable: false, reason: 'browser_api_rejected',
    tool: name, message: error?.message ? String(error.message) : String(error),
    ...extra
  };
}

function badRequest(name, reason, message, extra = {}) {
  return { status: 'denied', retryable: false, reason, tool: name, message, ...extra };
}

const limit = (value, fallback, max) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(1, Math.trunc(number)));
};

// Bookmarks and history are trees of attacker-supplied strings. Returning the
// raw chrome node would also drag along every field Chrome happens to add, so
// each row is projected to what a caller can act on.
function bookmarkRow(node) {
  return {
    id: node.id,
    parentId: node.parentId ?? null,
    title: node.title ?? '',
    url: node.url ?? null,
    dateAdded: node.dateAdded ?? null,
    dateGroupModified: node.dateGroupModified ?? null,
    folder: !node.url,
    childCount: Array.isArray(node.children) ? node.children.length : undefined
  };
}

function walkBookmarks(nodes, rows, depth, maxDepth) {
  for (const node of nodes ?? []) {
    rows.push({ ...bookmarkRow(node), depth });
    if (node.children?.length && depth < maxDepth) walkBookmarks(node.children, rows, depth + 1, maxDepth);
  }
  return rows;
}

function historyRow(item) {
  return {
    url: item.url ?? null,
    title: item.title ?? '',
    lastVisitTime: item.lastVisitTime ?? null,
    visitCount: item.visitCount ?? null,
    typedCount: item.typedCount ?? null
  };
}

// DownloadItem carries absolute filesystem paths and the full URL. Both are
// returned because a caller cleaning up a download needs them, but the size of
// the object is the problem: returning it whole would push megabytes of
// per-chunk metadata through the socket for a list of ten files.
function downloadRow(item) {
  return {
    id: item.id,
    filename: item.filename ?? null,
    url: item.url ?? null,
    finalUrl: item.finalUrl ?? null,
    state: item.state ?? null,
    paused: item.paused ?? null,
    canResume: item.canResume ?? null,
    bytesReceived: item.bytesReceived ?? null,
    totalBytes: item.totalBytes ?? null,
    mime: item.mime ?? null,
    startTime: item.startTime ?? null,
    endTime: item.endTime ?? null,
    exists: item.exists ?? null,
    danger: item.danger ?? null,
    error: item.error ?? null
  };
}

function windowRow(win) {
  return {
    id: win.id,
    focused: win.focused ?? null,
    state: win.state ?? null,
    type: win.type ?? null,
    incognito: win.incognito ?? null,
    alwaysOnTop: win.alwaysOnTop ?? null,
    left: win.left ?? null, top: win.top ?? null,
    width: win.width ?? null, height: win.height ?? null,
    tabCount: Array.isArray(win.tabs) ? win.tabs.length : undefined
  };
}

function sessionRow(entry) {
  const base = { sessionId: null, lastModified: entry.lastModified ?? null, kind: null };
  if (entry.tab) {
    return { ...base, sessionId: entry.tab.sessionId ?? null, kind: 'tab',
      tab: { url: entry.tab.url ?? null, title: entry.tab.title ?? '', pinned: entry.tab.pinned ?? null } };
  }
  if (entry.window) {
    const tabs = (entry.window.tabs ?? []).map(tab => ({ url: tab.url ?? null, title: tab.title ?? '' }));
    return { ...base, sessionId: entry.window.sessionId ?? null, kind: 'window', tabCount: tabs.length, tabs };
  }
  return base;
}

// ---------------------------------------------------------------------------
// sessions - the "recently closed" list, and the only way to undo a close.
// ---------------------------------------------------------------------------

async function sessionRestore(args) {
  const action = args.action ?? 'list';
  if (action === 'list') {
    const maxResults = limit(args.maxResults, 25, 25);
    const entries = await chrome.sessions.getRecentlyClosed({ maxResults });
    return {
      status: 'success', retryable: true, action, count: entries.length,
      sessions: entries.map(sessionRow), contentTrust: UNTRUSTED,
      note: 'Restoring is additive and does not replay anything, so a list can be read again safely. A restore consumes the entry, which is why it is never retried automatically.'
    };
  }
  if (action !== 'restore') return badRequest('browser_session_restore', 'unknown_action', `Unknown action "${action}"; use list or restore.`);
  // Restoring without an id restores the most recently closed entry, which is
  // what clicking "Restore" on the browser's own bubble does. An explicit id is
  // preferred because the list can move between the read and the restore.
  const restored = args.sessionId ? await chrome.sessions.restore(args.sessionId) : await chrome.sessions.restore();
  const restoredTab = restored?.tab ?? null;
  const restoredWindow = restored?.window ?? null;
  return {
    status: 'success', retryable: false, action, verified: Boolean(restoredTab || restoredWindow),
    restored: restoredTab
      ? { kind: 'tab', tabId: restoredTab.id ?? null, url: restoredTab.url ?? null, title: restoredTab.title ?? '', active: restoredTab.active ?? null, windowId: restoredTab.windowId ?? null }
      : { kind: 'window', windowId: restoredWindow.id ?? null, tabCount: restoredWindow.tabs?.length ?? 0,
          tabs: (restoredWindow.tabs ?? []).map(tab => ({ tabId: tab.id ?? null, url: tab.url ?? null, title: tab.title ?? '' })) },
    contentTrust: UNTRUSTED,
    note: 'A restored tab or window is not activated by this call unless the browser decides to. Read browser_tabs to confirm what is now open before acting on it.'
  };
}

// ---------------------------------------------------------------------------
// bookmarks
// ---------------------------------------------------------------------------

async function bookmarksRead(args) {
  const action = args.action ?? 'tree';
  if (action === 'tree') {
    const maxDepth = limit(args.maxDepth, 6, 12);
    const rows = walkBookmarks(await chrome.bookmarks.getTree(), [], 0, maxDepth);
    return { status: 'success', action, maxDepth, count: rows.length, bookmarks: rows, contentTrust: UNTRUSTED,
      note: 'A folder has folder:true and no url. Deeper folders are omitted past maxDepth rather than silently flattened.' };
  }
  if (action === 'search') {
    const query = String(args.query ?? '');
    if (!query) return badRequest('browser_bookmarks', 'query_required', 'Searching bookmarks needs a non-empty query.');
    const rows = (await chrome.bookmarks.search(query)).slice(0, limit(args.limit, 50, 200)).map(bookmarkRow);
    return { status: 'success', action, query, count: rows.length, bookmarks: rows, contentTrust: UNTRUSTED };
  }
  if (action === 'recent') {
    const rows = (await chrome.bookmarks.getRecent(limit(args.limit, 25, 100))).map(bookmarkRow);
    return { status: 'success', action, count: rows.length, bookmarks: rows, contentTrust: UNTRUSTED };
  }
  if (action === 'get') {
    if (!args.id) return badRequest('browser_bookmarks', 'id_required', 'Reading one bookmark needs its id.');
    const rows = (await chrome.bookmarks.get(String(args.id))).map(bookmarkRow);
    return { status: 'success', action, count: rows.length, bookmarks: rows, contentTrust: UNTRUSTED };
  }
  return badRequest('browser_bookmarks', 'unknown_action', `Unknown action "${action}"; use tree, search, recent or get.`);
}

async function bookmarksWrite(args) {
  const action = args.action;
  if (action === 'create') {
    const title = String(args.title ?? '');
    const url = args.url ? String(args.url) : null;
    const parentId = args.parentId ? String(args.parentId) : undefined;
    if (!title && !url) return badRequest('browser_bookmarks_write', 'title_or_url_required', 'Creating a bookmark needs a title or a url.');
    const created = url
      ? await chrome.bookmarks.create({ title, url, ...(parentId ? { parentId } : {}) })
      : await chrome.bookmarks.create({ title, ...(parentId ? { parentId } : {}) });
    return { status: 'success', retryable: false, action, created: bookmarkRow(created), contentTrust: UNTRUSTED };
  }
  if (action === 'update') {
    if (!args.id) return badRequest('browser_bookmarks_write', 'id_required', 'Updating a bookmark needs its id.');
    const changes = {};
    if (typeof args.title === 'string') changes.title = args.title;
    if (typeof args.url === 'string') changes.url = args.url;
    if (!Object.keys(changes).length) return badRequest('browser_bookmarks_write', 'no_changes', 'Updating a bookmark needs a title or a url.');
    const updated = await chrome.bookmarks.update(String(args.id), changes);
    return { status: 'success', retryable: false, action, updated: bookmarkRow(updated), contentTrust: UNTRUSTED };
  }
  if (action === 'remove') {
    if (!args.id) return badRequest('browser_bookmarks_write', 'id_required', 'Removing a bookmark needs its id.');
    // A folder removal is recursive in Chrome and takes every child with it, so
    // the caller has to have said so rather than discovering it afterwards.
    const recursive = args.recursive === true;
    await (recursive ? chrome.bookmarks.removeTree(String(args.id)) : chrome.bookmarks.remove(String(args.id)));
    return { status: 'success', retryable: false, action, removedId: String(args.id), recursive,
      verified: (await chrome.bookmarks.get(String(args.id)).catch(() => [])).length === 0,
      note: recursive ? 'The folder and every bookmark inside it were removed.' : 'Chrome refuses to remove a non-empty folder this way; pass recursive:true for that.' };
  }
  if (action === 'move') {
    if (!args.id || !args.parentId) return badRequest('browser_bookmarks_write', 'id_and_parent_required', 'Moving a bookmark needs id and parentId.');
    const moved = await chrome.bookmarks.move(String(args.id), { parentId: String(args.parentId), ...(Number.isInteger(args.index) ? { index: args.index } : {}) });
    return { status: 'success', retryable: false, action, moved: bookmarkRow(moved) };
  }
  return badRequest('browser_bookmarks_write', 'unknown_action', `Unknown action "${action}"; use create, update, remove or move.`);
}

// ---------------------------------------------------------------------------
// history and top sites
// ---------------------------------------------------------------------------

async function historyRead(args) {
  const action = args.action ?? 'search';
  if (action === 'search' || action === 'recent') {
    const maxResults = limit(args.maxResults, 50, 500);
    const items = await chrome.history.search({
      text: String(args.query ?? ''),
      startTime: Number.isFinite(args.startTime) ? args.startTime : 0,
      endTime: Number.isFinite(args.endTime) ? args.endTime : Date.now(),
      maxResults
    });
    return { status: 'success', action, count: items.length, entries: items.map(historyRow), contentTrust: UNTRUSTED };
  }
  if (action === 'visits') {
    const url = String(args.url ?? '');
    if (!url) return badRequest('browser_history_search', 'url_required', 'Reading visits needs a url.');
    const visits = (await chrome.history.getVisits({ url })).slice(0, limit(args.limit, 100, 1000));
    return { status: 'success', action, url, count: visits.length,
      visits: visits.map(visit => ({ visitId: visit.visitId, visitTime: visit.visitTime ?? null, transition: visit.transition ?? null, referringVisitId: visit.referringVisitId ?? null })) };
  }
  if (action === 'top') {
    // Most-visited is the new-tab-page list, which is a different data source
    // from history.search: it is ranked rather than time-ordered.
    const sites = await chrome.topSites.get();
    return { status: 'success', action, count: sites.length,
      sites: sites.slice(0, limit(args.limit, 50, 200)).map(site => ({ url: site.url ?? null, title: site.title ?? '' })),
      contentTrust: UNTRUSTED };
  }
  return badRequest('browser_history_search', 'unknown_action', `Unknown action "${action}"; use search, recent, visits or top.`);
}

async function historyDelete(args) {
  const action = args.action;
  if (action === 'url') {
    const url = String(args.url ?? '');
    if (!url) return badRequest('browser_history_delete', 'url_required', 'Deleting history needs a url.');
    await chrome.history.deleteUrl({ url });
    // deleteUrl also removes the visits that were recorded for that URL, so the
    // only honest verification is that a search no longer finds it.
    const left = await chrome.history.search({ text: url, maxResults: 5 });
    return { status: 'success', retryable: false, action, url,
      verified: !left.some(item => item.url === url),
      note: 'Every visit of that exact URL is gone. Other URLs on the same site are untouched.' };
  }
  if (action === 'range') {
    const startTime = Number(args.startTime);
    const endTime = Number(args.endTime);
    if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime < startTime) {
      return badRequest('browser_history_delete', 'range_required', 'Deleting a range needs numeric startTime and endTime with endTime >= startTime.');
    }
    await chrome.history.deleteRange({ startTime, endTime });
    return { status: 'success', retryable: false, action, startTime, endTime,
      note: 'Chrome does not report how many entries a range deletion removed, so this call cannot verify a count.' };
  }
  if (action === 'all') {
    await chrome.history.deleteAll();
    const left = await chrome.history.search({ text: '', maxResults: 1 });
    return { status: 'success', retryable: false, action, verified: left.length === 0,
      note: 'The whole history database was deleted. This is not recoverable.' };
  }
  return badRequest('browser_history_delete', 'unknown_action', `Unknown action "${action}"; use url, range or all.`);
}

// ---------------------------------------------------------------------------
// downloads
// ---------------------------------------------------------------------------

async function downloadsRead(args) {
  const query = {};
  if (Number.isInteger(args.downloadId)) query.id = args.downloadId;
  if (typeof args.query === 'string' && args.query) query.query = [args.query];
  if (typeof args.state === 'string') query.state = args.state;
  if (typeof args.mime === 'string') query.mime = args.mime;
  if (Number.isFinite(args.startedAfter)) query.startedAfter = args.startedAfter;
  if (Number.isFinite(args.endedBefore)) query.endedBefore = args.endedBefore;
  if (Number.isInteger(args.limit)) query.limit = limit(args.limit, 50, 500);
  const items = await chrome.downloads.search(query);
  const rows = items.slice(0, limit(args.limit, 50, 500)).map(downloadRow);
  return { status: 'success', count: rows.length, downloads: rows, contentTrust: UNTRUSTED,
    note: 'filename is an absolute local path. exists says whether the file is still on disk; Chrome cannot report that for a file it was never allowed to stat.' };
}

async function downloadsControl(args) {
  const action = args.action;
  const id = args.downloadId;
  if (!Number.isInteger(id)) return badRequest('browser_downloads_control', 'download_id_required', 'Controlling a download needs a numeric downloadId.');
  if (action === 'pause') return { status: 'success', retryable: true, action, downloadId: id, changed: await chrome.downloads.pause(id) };
  if (action === 'resume') return { status: 'success', retryable: true, action, downloadId: id, changed: await chrome.downloads.resume(id) };
  if (action === 'cancel') return { status: 'success', retryable: false, action, downloadId: id, changed: await chrome.downloads.cancel(id) };
  if (action === 'open') {
    // Opening a download hands the file to the OS, which is exactly what a
    // human does by clicking it, and is also the moment a downloaded installer
    // runs. The result can only say the request was accepted.
    await chrome.downloads.open(id);
    return { status: 'success', retryable: false, action, downloadId: id, dispatched: true, verified: false,
      note: 'The file was handed to the operating system. Whatever the OS does with it is outside this call, so nothing here confirms an application opened it.' };
  }
  if (action === 'show') {
    await chrome.downloads.show(id);
    return { status: 'success', retryable: false, action, downloadId: id, dispatched: true, verified: false,
      note: 'The download shelf was asked to reveal the item; whether the window came forward was not measured.' };
  }
  if (action === 'erase') {
    // erase removes the row from the download list. It does not delete the file,
    // and a caller that assumes otherwise would think it cleaned up.
    await chrome.downloads.erase({ id });
    return { status: 'success', retryable: false, action, downloadId: id,
      fileDeleted: false, note: 'Only the history row was erased. The file on disk is untouched.' };
  }
  return badRequest('browser_downloads_control', 'unknown_action', `Unknown action "${action}"; use pause, resume, cancel, open, show or erase.`);
}

// ---------------------------------------------------------------------------
// extension manager
// ---------------------------------------------------------------------------

function extensionRow(info) {
  return {
    id: info.id,
    name: info.name ?? '',
    shortName: info.shortName ?? null,
    version: info.version ?? null,
    enabled: info.enabled ?? null,
    type: info.type ?? null,
    installType: info.installType ?? null,
    mayDisable: info.mayDisable ?? null,
    description: info.description ?? null,
    isBridge: info.id === chrome.runtime.id
  };
}

async function extensionsRead(args) {
  const all = await chrome.management.getAll();
  const rows = all.map(extensionRow)
    .filter(row => args.enabledOnly === true ? row.enabled === true : true)
    .sort((left, right) => Number(right.isBridge) - Number(left.isBridge) || left.name.localeCompare(right.name));
  return { status: 'success', count: rows.length, extensions: rows, contentTrust: UNTRUSTED,
    note: 'isBridge marks this bridge extension. mayDisable:false means Chrome itself protects the item (component or policy-installed).' };
}

async function extensionState(args) {
  const action = args.action;
  const id = String(args.extensionId ?? '');
  if (!id) return badRequest('browser_extension_state', 'extension_id_required', 'Changing an extension needs its id; read browser_extensions first.');
  // Disabling the bridge would sever the connection this call is travelling on,
  // and the caller would see a timeout instead of a result. Refusing is the only
  // answer that can be reported; a human can still do it from chrome://extensions.
  if (id === chrome.runtime.id && action !== 'enable') {
    return badRequest('browser_extension_state', 'bridge_extension_protected',
      'This is the bridge extension. Disabling or removing it would cut the connection that carries this call, so the request is refused instead of being executed and lost.');
  }
  if (action === 'enable' || action === 'disable') {
    await chrome.management.setEnabled(id, action === 'enable');
    const after = await chrome.management.get(id).catch(() => null);
    return { status: 'success', retryable: false, action, extensionId: id,
      verified: after ? after.enabled === (action === 'enable') : false, enabled: after?.enabled ?? null,
      note: 'Chrome may reload the extension as a side effect of being enabled.' };
  }
  if (action === 'uninstall') {
    // Chrome shows its own confirmation dialog for this unless the item was
    // installed by policy, so the promise resolves only after the user agreed.
    await chrome.management.uninstall(id, { showConfirmDialog: args.showConfirmDialog !== false });
    const left = await chrome.management.getAll();
    return { status: 'success', retryable: false, action, extensionId: id,
      verified: !left.some(item => item.id === id),
      note: 'If Chrome displayed its own confirmation dialog and the user declined, the item is still present and verified reports that.' };
  }
  return badRequest('browser_extension_state', 'unknown_action', `Unknown action "${action}"; use enable, disable or uninstall.`);
}

// ---------------------------------------------------------------------------
// cookies
// ---------------------------------------------------------------------------

// A cookie row is a credential. httpOnly cookies are unreadable from page script
// and are readable here, which is the whole reason this tool exists - a session
// token lives in one. The value is returned because exporting or repairing a
// session needs it, but the envelope says what it is so no caller mistakes it
// for display data.
function cookieRow(cookie) {
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain ?? null,
    path: cookie.path ?? null,
    secure: cookie.secure ?? null,
    httpOnly: cookie.httpOnly ?? null,
    sameSite: cookie.sameSite ?? null,
    session: cookie.session ?? null,
    expirationDate: cookie.expirationDate ?? null,
    hostOnly: cookie.hostOnly ?? null,
    storeId: cookie.storeId ?? null
  };
}

async function cookiesRead(args) {
  const target = {};
  // Deliberately no "all cookies everywhere" mode: a call has to name the URL or
  // the domain it is about, so a cookie dump of every site is not one request
  // away. That is also what makes the result explainable after the fact.
  if (args.url) target.url = String(args.url);
  else if (args.domain) target.domain = String(args.domain);
  else return badRequest('browser_cookies', 'url_or_domain_required', 'Reading cookies needs a url or a domain; there is no read-everything mode.');
  if (args.name) target.name = String(args.name);
  if (args.storeId) target.storeId = String(args.storeId);
  const cookies = await chrome.cookies.getAll(target);
  const rows = cookies.slice(0, limit(args.limit, 200, 1000)).map(cookieRow);
  return { status: 'success', count: rows.length, cookies: rows,
    secrets: true,
    note: 'Values are live credentials. Never write them to a log, a report or a page, and never send them anywhere except the site they belong to.'
  };
}

async function cookiesWrite(args) {
  const action = args.action;
  if (action === 'set') {
    const url = String(args.url ?? '');
    const name = String(args.name ?? '');
    if (!url || !name) return badRequest('browser_cookies_write', 'url_and_name_required', 'Setting a cookie needs url and name.');
    const details = { url, name, value: String(args.value ?? '') };
    if (typeof args.domain === 'string') details.domain = args.domain;
    if (typeof args.path === 'string') details.path = args.path;
    if (typeof args.secure === 'boolean') details.secure = args.secure;
    if (typeof args.httpOnly === 'boolean') details.httpOnly = args.httpOnly;
    if (typeof args.sameSite === 'string') details.sameSite = args.sameSite;
    if (Number.isFinite(args.expirationDate)) details.expirationDate = args.expirationDate;
    const cookie = await chrome.cookies.set(details);
    return { status: 'success', retryable: false, action, set: cookie ? cookieRow({ ...cookie, value: args.value }) : null,
      verified: Boolean(cookie), secrets: true };
  }
  if (action === 'remove') {
    const url = String(args.url ?? '');
    const name = String(args.name ?? '');
    if (!url || !name) return badRequest('browser_cookies_write', 'url_and_name_required', 'Removing a cookie needs url and name.');
    const removed = await chrome.cookies.remove({ url, name, ...(args.storeId ? { storeId: String(args.storeId) } : {}) });
    return { status: 'success', retryable: false, action, removed: Boolean(removed),
      note: 'A null result means Chrome found no such cookie; that is reported as removed:false rather than as success.' };
  }
  return badRequest('browser_cookies_write', 'unknown_action', `Unknown action "${action}"; use set or remove.`);
}

// ---------------------------------------------------------------------------
// browsing data
// ---------------------------------------------------------------------------

const BROWSING_DATA_TYPES = new Set([
  'cache', 'cacheStorage', 'cookies', 'downloads', 'fileSystems', 'formData', 'history',
  'indexedDB', 'localStorage', 'passwords', 'pluginData', 'serviceWorkers', 'webSQL'
]);

async function clearBrowsingData(args) {
  const requested = Array.isArray(args.dataTypes) ? args.dataTypes : [];
  const dataTypes = [...new Set(requested.filter(type => BROWSING_DATA_TYPES.has(type)))];
  const unknown = requested.filter(type => !BROWSING_DATA_TYPES.has(type));
  if (!dataTypes.length) {
    return badRequest('browser_clear_browsing_data', 'data_types_required',
      `Nothing was cleared: name at least one data type. Known types: ${[...BROWSING_DATA_TYPES].join(', ')}.`, { unknown });
  }
  const options = {};
  if (Number.isFinite(args.since)) options.since = args.since;
  if (Array.isArray(args.origins) && args.origins.length) options.origins = args.origins.map(String);
  const removal = Object.fromEntries(dataTypes.map(type => [type, true]));
  await chrome.browsingData.remove(options, removal);
  return {
    status: 'success', retryable: false,
    cleared: dataTypes, ignored: unknown, scope: options,
    verified: false,
    note: 'Chrome does not report what it removed, so this cannot verify a count. "passwords" removes saved passwords; "cookies" signs the user out of every site in scope.'
  };
}

// ---------------------------------------------------------------------------
// site settings (contentSettings)
// ---------------------------------------------------------------------------

const CONTENT_SETTING_TYPES = new Set([
  'automaticDownloads', 'autoSelectCertificateForUrls', 'camera', 'clipboard', 'cookies',
  'fullscreen', 'geolocation', 'hid', 'idleDetection', 'images', 'javascript', 'mic', 'midi',
  'mouselock', 'notifications', 'paymentHandler', 'plugins', 'popups', 'sensors', 'serial',
  'sound', 'usb', 'webBluetooth', 'webLocks', 'webSerial'
]);

function contentSettingsFor(type) {
  const api = chrome.contentSettings?.[type];
  if (!api) return null;
  return api;
}

async function siteSettingsRead(args) {
  const type = String(args.type ?? '');
  const api = contentSettingsFor(type);
  if (!api) {
    return badRequest('browser_site_settings', 'unknown_setting_type',
      `Chrome has no content setting "${type}". Known types: ${[...CONTENT_SETTING_TYPES].join(', ')}.`);
  }
  const url = String(args.url ?? args.primaryUrl ?? '');
  if (!url) return badRequest('browser_site_settings', 'url_required', 'Reading a site setting needs the page URL it applies to.');
  const details = { primaryUrl: url };
  if (typeof args.secondaryUrl === 'string') details.secondaryUrl = args.secondaryUrl;
  const result = await api.get(details);
  return { status: 'success', type, url, setting: result.setting ?? null, source: result.source ?? null,
    // Chrome 156 no longer fills in `source` for every content setting, so a
    // null here means "not reported", never "there is no exception".
    note: result.source
      ? 'source says where the answer came from: a per-site exception, a global default, or the browser default.'
      : 'This Chrome version did not report where the setting comes from, so only the effective value is known.' };
}

async function siteSettingsWrite(args) {
  const type = String(args.type ?? '');
  const api = contentSettingsFor(type);
  if (!api) {
    return badRequest('browser_site_settings_write', 'unknown_setting_type',
      `Chrome has no content setting "${type}". Known types: ${[...CONTENT_SETTING_TYPES].join(', ')}.`);
  }
  const action = args.action ?? 'set';
  if (action === 'set') {
    const primaryPattern = String(args.primaryPattern ?? '');
    const setting = String(args.setting ?? '');
    if (!primaryPattern) return badRequest('browser_site_settings_write', 'pattern_required', 'Setting a site setting needs a primaryPattern such as "https://example.com/*".');
    if (!setting) return badRequest('browser_site_settings_write', 'setting_required', 'Setting a site setting needs a value such as "allow", "block" or "ask".');
    const details = { primaryPattern, setting };
    if (typeof args.secondaryPattern === 'string') details.secondaryPattern = args.secondaryPattern;
    if (args.scope === 'regular' || args.scope === 'incognito_regular') details.scope = args.scope;
    await api.set(details);
    // Reading back is the only proof the browser accepted the value; a rejected
    // pattern throws, but a normalised one does not.
    const after = await api.get({ primaryUrl: args.primaryUrl ? String(args.primaryUrl) : primaryPattern.replace(/\*$/, '') }).catch(() => null);
    return { status: 'success', retryable: false, action, type, primaryPattern, requested: setting,
      observed: after?.setting ?? null, verified: after ? after.setting === setting : false };
  }
  if (action === 'clear') {
    const details = {};
    if (args.primaryPattern) details.primaryPattern = String(args.primaryPattern);
    await api.clear(details);
    return { status: 'success', retryable: false, action, type, clearedPattern: details.primaryPattern ?? 'all patterns for this setting',
      note: 'Clearing with no pattern removes every exception of this type and falls back to the global default.' };
  }
  return badRequest('browser_site_settings_write', 'unknown_action', `Unknown action "${action}"; use set or clear.`);
}

// ---------------------------------------------------------------------------
// privacy settings
// ---------------------------------------------------------------------------

const PRIVACY_AREAS = { network: chrome.privacy?.network, services: chrome.privacy?.services, websites: chrome.privacy?.websites };

function privacySetting(area, name) {
  const group = PRIVACY_AREAS[area];
  const setting = group?.[name];
  if (!setting) return null;
  return setting;
}

async function privacyRead(args) {
  const area = String(args.area ?? '');
  const name = String(args.name ?? '');
  const setting = privacySetting(area, name);
  if (!setting) {
    const known = Object.entries(PRIVACY_AREAS)
      .filter(([, group]) => group)
      .map(([key, group]) => `${key}: ${Object.keys(group).join(', ')}`);
    return badRequest('browser_privacy_settings', 'unknown_privacy_setting',
      `Chrome has no privacy setting "${area}.${name}". Known settings: ${known.join(' | ')}.`);
  }
  const result = await setting.get({});
  return { status: 'success', area, name, value: result.value ?? null, levelOfControl: result.levelOfControl ?? null,
    note: 'levelOfControl says whether this browser, an extension or a policy owns the value; "controlled_by_other_extensions" and "not_controllable" mean a write here will not take effect.' };
}

async function privacyWrite(args) {
  const area = String(args.area ?? '');
  const name = String(args.name ?? '');
  const setting = privacySetting(area, name);
  if (!setting) {
    const known = Object.entries(PRIVACY_AREAS)
      .filter(([, group]) => group)
      .map(([key, group]) => `${key}: ${Object.keys(group).join(', ')}`);
    return badRequest('browser_privacy_settings_write', 'unknown_privacy_setting',
      `Chrome has no privacy setting "${area}.${name}". Known settings: ${known.join(' | ')}.`);
  }
  const before = await setting.get({}).catch(() => ({}));
  if (args.reset === true) {
    await setting.clear({});
    const after = await setting.get({}).catch(() => ({}));
    return { status: 'success', retryable: false, area, name, reset: true,
      before: before.value ?? null, after: after.value ?? null, verified: true };
  }
  if (typeof args.value !== 'boolean') {
    return badRequest('browser_privacy_settings_write', 'value_required', 'Every privacy setting here is a boolean; pass value:true, value:false, or reset:true.');
  }
  await setting.set({ value: args.value, ...(args.scope ? { scope: args.scope } : {}) });
  const after = await setting.get({}).catch(() => ({}));
  return { status: 'success', retryable: false, area, name, before: before.value ?? null, after: after.value ?? null,
    verified: after.value === args.value,
    levelOfControl: after.levelOfControl ?? null };
}

// ---------------------------------------------------------------------------
// windows
// ---------------------------------------------------------------------------

async function windowsRead(args) {
  const getInfo = { populate: args.includeTabs === true };
  const windows = args.windowId
    ? [await chrome.windows.get(Number(args.windowId), getInfo)]
    : await chrome.windows.getAll(getInfo);
  return { status: 'success', count: windows.length, windows: windows.map(windowRow),
    note: 'focused is what the browser reports, not a measurement of which window the OS considers active.' };
}

async function windowsControl(args) {
  const action = args.action;
  if (action === 'create') {
    // focused:false is the default because a window that appears in front of
    // someone who is working elsewhere is the exact interruption this project
    // exists to avoid. A caller that wants the window in front has to say so.
    const wantFocused = args.focused === true;
    const createData = { focused: wantFocused, ...(args.url ? { url: String(args.url) } : {}) };
    if (args.state === 'maximized' || args.state === 'minimized' || args.state === 'fullscreen') createData.state = args.state;
    if (['normal', 'popup', 'panel'].includes(args.type)) createData.type = args.type;
    for (const key of ['left', 'top', 'width', 'height']) {
      if (Number.isFinite(args[key])) createData[key] = Number(args[key]);
    }
    const created = await chrome.windows.create(createData);
    return { status: 'success', retryable: false, action, window: windowRow(created), activated: wantFocused,
      note: 'Incognito windows are never created: a separate cookie jar looks like a logged-out session.' };
  }
  const id = Number(args.windowId);
  if (!Number.isInteger(id)) return badRequest('browser_windows_control', 'window_id_required', 'Controlling a window needs a numeric windowId; read browser_windows first.');
  if (action === 'update') {
    const updateInfo = {};
    for (const key of ['left', 'top', 'width', 'height']) {
      if (Number.isFinite(args[key])) updateInfo[key] = Number(args[key]);
    }
    if (typeof args.focused === 'boolean') updateInfo.focused = args.focused;
    if (['normal', 'minimized', 'maximized', 'fullscreen'].includes(args.state)) updateInfo.state = args.state;
    if (!Object.keys(updateInfo).length) {
      return badRequest('browser_windows_control', 'no_changes', 'Updating a window needs a geometry field, a state or focused.');
    }
    const updated = await chrome.windows.update(id, updateInfo);
    return { status: 'success', retryable: false, action, window: windowRow(updated),
      focusRequested: updateInfo.focused ?? false };
  }
  if (action === 'remove') {
    await chrome.windows.remove(id);
    const left = await chrome.windows.getAll({}).catch(() => []);
    return { status: 'success', retryable: false, action, windowId: id,
      verified: !left.some(win => win.id === id),
      note: 'Every tab in that window was closed. If any of them had unsaved work it is gone; Chrome does not offer an undo for a programmatic window close.' };
  }
  return badRequest('browser_windows_control', 'unknown_action', `Unknown action "${action}"; use create, update or remove.`);
}

// ---------------------------------------------------------------------------
// tab groups
// ---------------------------------------------------------------------------

async function tabGroups(args) {
  const action = args.action ?? 'list';
  if (action === 'list') {
    const groups = await chrome.tabGroups.query(args.windowId ? { windowId: Number(args.windowId) } : {});
    return { status: 'success', action, count: groups.length,
      groups: groups.map(group => ({
        groupId: group.id, title: group.title ?? '', color: group.color ?? null,
        collapsed: group.collapsed ?? null, windowId: group.windowId ?? null
      })), contentTrust: UNTRUSTED };
  }
  const tabIds = Array.isArray(args.tabIds) ? args.tabIds.filter(Number.isInteger) : [];
  if (!tabIds.length) return badRequest('browser_tab_groups', 'tab_ids_required', 'This action needs at least one numeric tabId.');
  if (action === 'group') {
    const groupId = await chrome.tabs.group({ tabIds, ...(Number.isInteger(args.groupId) ? { groupId: Number(args.groupId) } : {}) });
    const update = {};
    if (typeof args.title === 'string') update.title = args.title;
    if (typeof args.color === 'string') update.color = args.color;
    if (typeof args.collapsed === 'boolean') update.collapsed = args.collapsed;
    if (Object.keys(update).length) await chrome.tabGroups.update(groupId, update);
    const after = (await chrome.tabGroups.query({})).find(group => group.id === groupId) ?? null;
    return { status: 'success', retryable: false, action, groupId, tabIds,
      group: after ? { groupId: after.id, title: after.title ?? '', color: after.color ?? null, collapsed: after.collapsed ?? null } : null };
  }
  if (action === 'ungroup') {
    await chrome.tabs.ungroup(tabIds);
    return { status: 'success', retryable: false, action, tabIds,
      note: 'Ungrouping removes the tabs from the group; the group title and colour are lost with it.' };
  }
  return badRequest('browser_tab_groups', 'unknown_action', `Unknown action "${action}"; use list, group or ungroup.`);
}

// ---------------------------------------------------------------------------
// page capture (Save page as...)
// ---------------------------------------------------------------------------

async function savePage(args) {
  const tabId = Number(args.tabId);
  if (!Number.isInteger(tabId)) return badRequest('browser_save_page', 'tab_id_required', 'Saving a page needs the tabId of the page to save.');
  const blob = await chrome.pageCapture.saveAsMHTML({ tabId });
  if (!blob) return failed('browser_save_page', new Error('Chrome returned no MHTML for that tab.'));
  // The archive goes to disk through the download manager rather than back
  // through the socket: a saved page is routinely several megabytes, and a
  // JSON payload of that size would be the largest thing this bridge ever sends
  // for a read-only operation.
  const url = URL.createObjectURL(blob);
  try {
    const downloadId = await chrome.downloads.download({
      url,
      filename: typeof args.filename === 'string' && args.filename ? args.filename : 'page-{{timestamp}}.mhtml',
      saveAs: false,
      conflictAction: 'uniquify'
    });
    return { status: 'success', retryable: false, tabId, downloadId, bytes: blob.size ?? null,
      note: 'The page was saved as MHTML through the download manager; read browser_downloads to confirm where it landed. Page resources are captured from cache, so a page that never finished loading is saved incomplete.' };
  } finally {
    // The object URL keeps the blob alive until it is revoked; the download
    // manager holds its own reference once download() has resolved.
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
}

// ---------------------------------------------------------------------------
// proxy
// ---------------------------------------------------------------------------

// Proxy configuration is how a human tests geo behaviour, pins traffic to a
// staging egress, or works around a broken DNS path. It is also the single
// switch that can silently route every credential on the machine through a host
// of someone else's choosing, which is why a write is confirmation-gated and the
// result always reports the effective mode rather than the requested one.
async function proxyControl(args) {
  const action = args.action ?? 'get';
  const details = { incognito: args.incognito === true };
  if (action === 'get') {
    const current = await chrome.proxy.settings.get(details);
    return { status: 'success', action, value: current.value ?? null, levelOfControl: current.levelOfControl ?? null,
      note: 'levelOfControl "controlled_by_other_extensions" or "not_controllable" means another extension or a policy owns this, so a write here would be ignored.' };
  }
  if (action === 'clear') {
    await chrome.proxy.settings.clear(details);
    const after = await chrome.proxy.settings.get(details).catch(() => null);
    return { status: 'success', retryable: false, action,
      after: after?.value ?? null, levelOfControl: after?.levelOfControl ?? null,
      note: 'Clearing returns the browser to its system proxy settings.' };
  }
  if (action === 'set') {
    const mode = String(args.mode ?? '');
    if (!['direct', 'auto_detect', 'pac_script', 'fixed_servers', 'system'].includes(mode)) {
      return badRequest('browser_proxy', 'mode_required', 'Setting a proxy needs mode: direct, auto_detect, pac_script, fixed_servers or system.');
    }
    const value = { mode };
    if (mode === 'pac_script') {
      if (typeof args.pacUrl === 'string') value.pacScript = { url: args.pacUrl };
      else if (typeof args.pacData === 'string') value.pacScript = { data: args.pacData };
      else return badRequest('browser_proxy', 'pac_required', 'pac_script mode needs pacUrl or pacData.');
    }
    if (mode === 'fixed_servers') {
      if (typeof args.rules !== 'string' || !args.rules) {
        return badRequest('browser_proxy', 'rules_required', 'fixed_servers mode needs rules such as "http=127.0.0.1:8080;https=127.0.0.1:8080" or "127.0.0.1:8080".');
      }
      const singleProxy = parseProxyRules(args.rules);
      if (!singleProxy) {
        return badRequest('browser_proxy', 'rules_unparseable',
          'rules must be "host:port" or "scheme=host:port;..." where every scheme points at the same host:port; nothing was changed.');
      }
      value.rules = { singleProxy };
      if (Array.isArray(args.bypassList) && args.bypassList.length) value.rules.bypassList = args.bypassList.map(String);
    }
    await chrome.proxy.settings.set({ value, scope: args.scope === 'regular_only' ? 'regular_only' : 'regular' });
    const after = await chrome.proxy.settings.get(details).catch(() => null);
    return { status: 'success', retryable: false, action, requested: value,
      observed: after?.value ?? null, verified: after?.value?.mode === mode,
      note: 'verified only means the browser accepted this mode; it does not prove traffic actually flows through the proxy.' };
  }
  return badRequest('browser_proxy', 'unknown_action', `Unknown action "${action}"; use get, set or clear.`);
}

// "http=127.0.0.1:8080;https=127.0.0.1:8080" or a bare "127.0.0.1:8080".
function parseProxyRules(rules) {
  const hostPort = text => {
    const match = String(text).trim().match(/^([^:\s]+):(\d{1,5})$/);
    if (!match) return null;
    const port = Number(match[2]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    return { host: match[1], port };
  };
  const parts = String(rules).split(';').map(part => part.trim()).filter(Boolean);
  const direct = parts.length === 1 && !parts[0].includes('=') ? hostPort(parts[0]) : null;
  if (direct) return { scheme: 'http', host: direct.host, port: direct.port };
  const byScheme = {};
  for (const part of parts) {
    const [scheme, target] = part.split('=');
    const parsed = hostPort(target ?? '');
    if (!parsed) return null;
    byScheme[scheme.trim().toLowerCase()] = { scheme: scheme.trim().toLowerCase(), host: parsed.host, port: parsed.port };
  }
  // Chrome's PacScript/singleProxy shape only carries one proxy; a per-scheme
  // string is mapped onto proxyForHttp when every scheme agrees, and refused
  // otherwise rather than silently picking one of them.
  const values = Object.values(byScheme);
  const first = values[0];
  if (!first) return null;
  const uniform = values.every(item => item.host === first.host && item.port === first.port);
  return uniform ? first : null;
}

// ---------------------------------------------------------------------------

const HANDLERS = {
  browser_session_restore: sessionRestore,
  browser_bookmarks: bookmarksRead,
  browser_bookmarks_write: bookmarksWrite,
  browser_history_search: historyRead,
  browser_history_delete: historyDelete,
  browser_downloads: downloadsRead,
  browser_downloads_control: downloadsControl,
  browser_extensions: extensionsRead,
  browser_extension_state: extensionState,
  browser_cookies: cookiesRead,
  browser_cookies_write: cookiesWrite,
  browser_clear_browsing_data: clearBrowsingData,
  browser_site_settings: siteSettingsRead,
  browser_site_settings_write: siteSettingsWrite,
  browser_privacy_settings: privacyRead,
  browser_privacy_settings_write: privacyWrite,
  browser_windows: windowsRead,
  browser_windows_control: windowsControl,
  browser_tab_groups: tabGroups,
  browser_save_page: savePage,
  browser_proxy: proxyControl,
  // Same handler, two tool names: reading the proxy is a plain read, while
  // setting it can route every credential on the machine somewhere else, so the
  // write lives behind its own confirmation-gated tool rather than sharing one.
  browser_proxy_write: proxyControl
};

export const AUTHORITY_TOOLS = new Set(Object.keys(HANDLERS));

// Returns null for a name this module does not own, so the worker can keep
// dispatching without a second list to maintain.
export async function runAuthorityTool(name, args = {}) {
  const handler = HANDLERS[name];
  if (!handler) return null;
  try {
    return await handler(args);
  } catch (error) {
    return failed(name, error);
  }
}
