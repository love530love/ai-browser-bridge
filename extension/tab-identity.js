// Session-reuse identity and tab ownership.
//
// Two problems this solves, both about not disturbing a real browser session:
//
// 1. Reuse must be generous enough to actually reuse. Comparing raw URL strings
//    treats `/x` and `/x/`, or a URL with and without a `#fragment`, as
//    different pages and opens a duplicate tab. Comparing too loosely (origin +
//    path only) would reuse a tab whose query string asks for something else,
//    which is worse than opening a new tab.
//
// 2. Closing must be conservative. `browser_close` used to remove any tab id it
//    was given, including tabs the user opened and was working in. Ownership is
//    recorded when the bridge creates a tab and checked before removal.
//
// Everything here is a pure function of its inputs so it can be unit tested
// without Chrome.

const CREATED_KEY = 'bridgeCreatedTabs';

// The identity used to decide "is this the same page I already have open".
// Returns null for anything that is not a plain HTTP(S) URL, so a caller can
// never accidentally treat an internal page as reusable.
export function reuseKey(raw) {
  let url;
  try { url = new URL(String(raw ?? '')); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  // A fragment is a position inside a document, not a different document.
  // A trailing slash is the same resource for virtually every server.
  const path = url.pathname.replace(/\/+$/, '') || '/';
  // The query string is kept verbatim: `?id=1` and `?id=2` are different pages,
  // and reusing across them would silently operate the wrong one.
  return `${url.protocol}//${url.host}${path}${url.search}`;
}

export function samePage(a, b) {
  const left = reuseKey(a);
  return left !== null && left === reuseKey(b);
}

// An incognito tab has its own cookie jar. Reading or writing it is not implied
// by "operate my browser", and doing so silently would look like a logged-out
// session. It stays out of the default view.
export function visibleTab(tab, { includeIncognito = false } = {}) {
  return Boolean(tab) && (includeIncognito || tab.incognito !== true);
}

// Is this a browser-internal surface rather than a web page?
export function isInternalPage(raw) {
  let url;
  try { url = new URL(String(raw ?? '')); } catch { return false; }
  return url.protocol !== 'http:' && url.protocol !== 'https:';
}

// A label for a page the bridge will not read: scheme, host and path only. The
// query and the fragment are dropped on purpose - chrome://history/?q=bank is
// the same kind of information as the page content, and none of it is needed to
// recognise which tab this is.
export function internalUrlLabel(raw) {
  let url;
  try { url = new URL(String(raw ?? '')); } catch { return null; }
  const path = url.pathname.replace(/\/+$/, '') || '/';
  return `${url.protocol}//${url.host}${path}`.slice(0, 120);
}

// How one tab is described to a caller.
//
// A tab the bridge cannot read is still a tab that exists. Hiding those made
// "what did I just open?" unanswerable: choosing New tab in Chrome's own menu
// creates one, and nothing in the bridge could see it afterwards. So the
// identity is reported and the content is not - no title, and for a disallowed
// web origin not even the URL, because that URL is the content.
export function describeTab(tab, { owned = false, allowed = true, restrictedReason = null } = {}) {
  const base = { id: tab.id, active: tab.active === true, windowId: tab.windowId,
    incognito: tab.incognito === true, bridgeCreated: owned === true };
  if (allowed) return { ...base, title: tab.title ?? '', url: tab.url ?? '', restricted: false };
  const reason = restrictedReason ?? (isInternalPage(tab.url) ? 'non_http' : 'origin_not_allowed');
  return { ...base, title: null, restricted: true, restrictedReason: reason,
    url: reason === 'origin_not_allowed' ? null : internalUrlLabel(tab.url) };
}

// Tab ownership, kept in chrome.storage.session so it survives a service worker
// suspension but still disappears when the browser closes. In-memory only would
// forget ownership on every worker restart and then refuse to close tabs the
// bridge itself opened.
export function createTabOwnership(storage) {
  const memory = new Set();
  const read = async () => {
    if (!storage?.get) return new Set(memory);
    try {
      const stored = await storage.get(CREATED_KEY);
      const list = stored?.[CREATED_KEY];
      const ids = new Set(Array.isArray(list) ? list.filter(Number.isSafeInteger) : []);
      for (const id of memory) ids.add(id);
      return ids;
    } catch { return new Set(memory); }
  };
  const write = async ids => {
    memory.clear();
    for (const id of ids) memory.add(id);
    if (!storage?.set) return;
    try { await storage.set({ [CREATED_KEY]: [...ids] }); } catch { /* memory copy still holds */ }
  };
  return {
    async ids() { return await read(); },
    async mark(tabId) {
      // Chrome tab ids are positive integers. A negative or non-integer value is
      // a caller bug, and storing it would make `owns` answer for a tab that
      // cannot exist.
      if (!Number.isSafeInteger(tabId) || tabId < 1) return;
      const ids = await read();
      ids.add(tabId);
      await write(ids);
    },
    async forget(tabId) {
      const ids = await read();
      if (!ids.delete(tabId)) return;
      await write(ids);
    },
    async owns(tabId) { return (await read()).has(tabId); }
  };
}
