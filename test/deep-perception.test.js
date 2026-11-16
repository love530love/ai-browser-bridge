import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDeepPerception,
  mapGeneratedPosition,
  sourceMapUrlFromScriptText,
  summarizeListener,
  summarizeSourceMap
} from '../extension/deep-perception.js';

const sourceMap = {
  version: 3,
  file: 'bundle.js',
  sources: ['src/app.ts', 'src/view.ts'],
  sourcesContent: ['export const app = 1;', 'export const view = 2;'],
  names: ['render'],
  mappings: 'AAAA,UCKEA'
};

const dataUri = `data:application/json;base64,${Buffer.from(JSON.stringify(sourceMap)).toString('base64')}`;

function fakeEventBus() {
  const listeners = new Set();
  return {
    onEvent: {
      addListener: listener => listeners.add(listener),
      removeListener: listener => listeners.delete(listener)
    },
    emit(source, method, params) {
      for (const listener of listeners) listener(source, method, params);
    },
    get size() { return listeners.size; }
  };
}

function makeAttach({ events = true, map = null, overrides = {} } = {}) {
  const bus = fakeEventBus();
  const calls = [];
  const attach = async (tabId, fn) => await fn(async (method, params = {}) => {
    calls.push({ method, params });
    if (Object.hasOwn(overrides, method)) return overrides[method];
    if (method === 'Debugger.enable' && events) {
      bus.emit({ tabId }, 'Debugger.scriptParsed', {
        scriptId: '1', url: 'https://example.test/app.js', length: 1200,
        startLine: 0, endLine: 20, isModule: true, sourceMapURL: map
      });
      bus.emit({ tabId }, 'Debugger.scriptParsed', {
        scriptId: '2', url: 'https://example.test/vendor.js', length: 9000,
        startLine: 0, endLine: 200, isModule: false, sourceMapURL: null
      });
    }
    if (method === 'Debugger.getScriptSource') {
      return { scriptSource: 'function secret() { return 42; }\n// second line\n' };
    }
    if (method === 'DOM.getDocument') return { root: { nodeId: 10 } };
    if (method === 'DOM.querySelectorAll') return { nodeIds: [11] };
    if (method === 'DOM.describeNode') {
      return { node: { nodeName: 'DIV', attributes: ['id', 'go', 'class', 'btn primary', 'type', 'button'] } };
    }
    if (method === 'DOM.resolveNode') return { object: { objectId: 'obj-1' } };
    if (method === 'DOMDebugger.getEventListeners') {
      return {
        listeners: [{
          type: 'click', useCapture: false, passive: false, once: false,
          scriptId: '1', lineNumber: 10, columnNumber: 4,
          handler: { className: 'Function', description: 'function onClick(event) { doSomething(); }' },
          origin: 'https://example.test'
        }]
      };
    }
    return {};
  });
  return { attach, calls, bus, tabId: 7 };
}

const tab = { id: 7, url: 'https://example.test/page' };
const sessions = { activeSend: () => null, get: () => null };

test('source map decoding resolves generated positions, names and indexed sections', () => {
  const first = mapGeneratedPosition(sourceMap, 1, 0);
  assert.deepEqual(first, { source: 'src/app.ts', originalLine: 1, originalColumn: 1, name: null });

  const second = mapGeneratedPosition(sourceMap, 1, 10);
  assert.deepEqual(second, { source: 'src/view.ts', originalLine: 6, originalColumn: 3, name: 'render' });

  const indexed = {
    version: 3,
    sections: [
      { offset: { line: 0, column: 0 }, map: sourceMap },
      {
        offset: { line: 2, column: 0 },
        map: {
          version: 3, sources: ['src/lazy.ts'], names: [], mappings: 'AAAA'
        }
      }
    ]
  };
  assert.equal(mapGeneratedPosition(indexed, 1, 0).source, 'src/app.ts');
  assert.equal(mapGeneratedPosition(indexed, 3, 0).source, 'src/lazy.ts');
  assert.equal(mapGeneratedPosition(indexed, 3, 0).originalLine, 1);
  assert.deepEqual(mapGeneratedPosition(indexed, 3, 0).sectionOffset, { line: 3, column: 0 });

  const external = {
    version: 3,
    sections: [{ offset: { line: 0, column: 0 }, url: 'lazy.map' }]
  };
  assert.match(mapGeneratedPosition(external, 1, 0).note, /external source map/);
});

test('source map summary lists sources and previews only the requested one', () => {
  const summary = summarizeSourceMap(sourceMap, { maxSources: 1, sourceIndex: 1, previewChars: 8, line: 1, column: 10 });
  assert.equal(summary.sourceCount, 2);
  assert.deepEqual(summary.sources, ['src/app.ts']);
  assert.equal(summary.sourcesTruncated, true);
  assert.equal(summary.sourcesContent.present, true);
  assert.equal(summary.sourcesContent.totalChars, 43);
  assert.equal(summary.sourceContent.available, true);
  assert.equal(summary.sourceContent.preview, 'export c…[truncated 14 chars]');
  assert.equal(summary.lineMapping.source, 'src/view.ts');
  assert.equal(summary.lineMapping.name, 'render');
});

test('listener summary maps script ids to URLs and keeps 1-based positions', () => {
  const scripts = new Map([['1', { scriptId: '1', url: 'https://example.test/app.js' }]]);
  const summary = summarizeListener({
    type: 'click', useCapture: true, passive: true, once: true,
    scriptId: '1', lineNumber: 0, columnNumber: 0,
    handler: { className: 'Function', description: 'function handler() { run(); }' },
    origin: 'https://example.test'
  }, scripts);
  assert.equal(summary.scriptUrl, 'https://example.test/app.js');
  assert.equal(summary.lineNumber, 1);
  assert.equal(summary.columnNumber, 1);
  assert.equal(summary.handlerName, 'handler');
  assert.equal(summary.useCapture, true);
  assert.equal(summary.passive, true);
  assert.equal(summary.once, true);
});

test('script inventory reads the bounded list and only returns source when asked', async () => {
  const fake = makeAttach({ map: dataUri });
  const module = createDeepPerception({
    sessions,
    attach: fake.attach,
    chromeApi: { debugger: { onEvent: fake.bus.onEvent } }
  });

  const listed = await module.run('browser_script_inventory', { tabId: 7, settleMs: 0, urlFilter: 'app' }, { tab });
  assert.equal(listed.status, 'success');
  assert.equal(listed.totalScripts, 2);
  assert.equal(listed.matchedCount, 1);
  assert.equal(listed.count, 1);
  assert.equal(listed.scripts[0].scriptId, '1');
  assert.equal(listed.scripts[0].isModule, true);
  assert.equal(listed.scripts[0].sourceMapURL, dataUri);
  assert.equal(listed.source, null);
  assert.equal(fake.bus.size, 0, 'the temporary script listener must be removed');

  const source = await module.run('browser_script_inventory', {
    tabId: 7, settleMs: 0, scriptId: '1', includeSource: true, maxSourceChars: 20
  }, { tab });
  assert.equal(source.status, 'success');
  assert.equal(source.source.scriptId, '1');
  assert.equal(source.source.text, 'function secret() { …[truncated 28 chars]');
  assert.match(source.source.contentTrust, /untrusted/);

  const denied = await module.run('browser_script_inventory', { tabId: 7, includeSource: true }, { tab });
  assert.equal(denied.status, 'denied');
  assert.equal(denied.reason, 'script_id_required');
});

test('source map reads a data-URI map and maps a generated line', async () => {
  const fake = makeAttach({ map: dataUri });
  const module = createDeepPerception({
    sessions,
    attach: fake.attach,
    chromeApi: { debugger: { onEvent: fake.bus.onEvent } }
  });

  const result = await module.run('browser_source_map', {
    tabId: 7, settleMs: 0, scriptId: '1', line: 1, column: 10, maxSources: 2
  }, { tab });
  assert.equal(result.status, 'success');
  assert.equal(result.via, 'data_uri');
  assert.equal(result.sourceCount, 2);
  assert.equal(result.lineMapping.source, 'src/view.ts');
  assert.equal(result.lineMapping.name, 'render');
  assert.equal(result.script.scriptId, '1');
});

test('a large inline data-URI source map is kept instead of clipped at the URL limit', async () => {
  const largeMap = {
    ...sourceMap,
    sourcesContent: ['const padding = "' + 'x'.repeat(900) + '";', 'export const view = 2;']
  };
  const largeDataUri = `data:application/json;base64,${Buffer.from(JSON.stringify(largeMap)).toString('base64')}`;
  assert.ok(largeDataUri.length > 500, 'this fixture must exceed the ordinary URL limit');
  const fake = makeAttach({ map: largeDataUri });
  const module = createDeepPerception({
    sessions,
    attach: fake.attach,
    chromeApi: { debugger: { onEvent: fake.bus.onEvent } }
  });

  const listed = await module.run('browser_script_inventory', { tabId: 7, settleMs: 0 }, { tab });
  assert.equal(listed.scripts[0].sourceMapURL.length, largeDataUri.length);
  assert.equal(listed.scripts[0].sourceMapURLTruncated, false);

  const result = await module.run('browser_source_map', { tabId: 7, settleMs: 0, scriptId: '1', line: 1, column: 0 }, { tab });
  assert.equal(result.status, 'success');
  assert.equal(result.via, 'data_uri');
  assert.equal(result.sourceCount, 2);
});

test('a truncated inline map is reported as partial, never parsed as a prefix', async () => {
  const send = async () => ({});
  const module = createDeepPerception({
    sessions: {
      activeSend: () => send,
      get: () => ({ scripts: new Map([['9', {
        scriptId: '9', url: 'https://example.test/huge.js',
        sourceMapURL: 'data:application/json;base64,AAAA', sourceMapURLTruncated: true
      }]]) })
    }
  });

  const result = await module.run('browser_source_map', { tabId: 7, scriptId: '9' }, { tab });
  assert.equal(result.status, 'partial');
  assert.equal(result.reason, 'source_map_url_truncated');
  assert.equal(result.script.sourceMapURLTruncated, true);
});

test('a malformed base64 data-URI map fails without throwing', async () => {
  const fake = makeAttach({ map: 'data:application/json;base64,%%%not-base64%%%' });
  const module = createDeepPerception({
    sessions,
    attach: fake.attach,
    chromeApi: { debugger: { onEvent: fake.bus.onEvent } }
  });

  const result = await module.run('browser_source_map', { tabId: 7, settleMs: 0, scriptId: '1' }, { tab });
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'source_map_data_uri_unreadable');
});

test('an empty listener type list means no filter, not zero matches', async () => {
  const fake = makeAttach();
  const module = createDeepPerception({
    sessions,
    attach: fake.attach,
    chromeApi: { debugger: { onEvent: fake.bus.onEvent } }
  });

  const result = await module.run('browser_event_listeners', { tabId: 7, selector: '#go', settleMs: 0, types: [] }, { tab });
  assert.equal(result.status, 'success');
  assert.equal(result.totalListeners, 1);
  assert.equal(result.types, undefined);
});

test('event listeners resolve one selector, map the handler and release the object group', async () => {
  const fake = makeAttach();
  const module = createDeepPerception({
    sessions,
    attach: fake.attach,
    chromeApi: { debugger: { onEvent: fake.bus.onEvent } }
  });

  const result = await module.run('browser_event_listeners', {
    tabId: 7, selector: '#go', settleMs: 0
  }, { tab });
  assert.equal(result.status, 'success');
  assert.equal(result.target.kind, 'element');
  assert.equal(result.target.id, 'go');
  assert.equal(result.target.type, 'button');
  assert.equal(result.count, 1);
  assert.equal(result.listeners[0].scriptUrl, 'https://example.test/app.js');
  assert.equal(result.listeners[0].lineNumber, 11);
  assert.equal(result.listeners[0].handlerName, 'onClick');
  assert.ok(fake.calls.some(call => call.method === 'Runtime.releaseObjectGroup'), 'the object group must be released');
});

test('event listeners refuse an ambiguous selector instead of merging handlers', async () => {
  const fake = makeAttach({ overrides: { 'DOM.querySelectorAll': { nodeIds: [11, 12] } } });
  const module = createDeepPerception({
    sessions,
    attach: fake.attach,
    chromeApi: { debugger: { onEvent: fake.bus.onEvent } }
  });

  const result = await module.run('browser_event_listeners', { tabId: 7, selector: '.btn', settleMs: 0 }, { tab });
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.reason, 'selector_ambiguous');
  assert.equal(result.matchCount, 2);
});

test('an already-open debugger session is reused without a second attachment', async () => {
  let attachCalls = 0;
  const send = async method => {
    if (method === 'DOMDebugger.getEventListeners') return { listeners: [] };
    if (method === 'Runtime.evaluate') return { result: { objectId: 'doc-1' } };
    if (method === 'Runtime.releaseObjectGroup') return {};
    return {};
  };
  const module = createDeepPerception({
    sessions: {
      activeSend: () => send,
      get: () => ({ scripts: new Map([['3', {
        scriptId: '3', url: 'https://example.test/live.js', startLine: 1, endLine: 2,
        sourceMapURL: null, length: 42, isModule: true, hasSourceURL: false
      }]]) })
    },
    attach: async () => { attachCalls += 1; throw new Error('must not attach'); }
  });

  const result = await module.run('browser_script_inventory', { tabId: 7 }, { tab });
  assert.equal(result.status, 'success');
  assert.equal(result.sessionReused, true);
  assert.equal(result.scripts[0].scriptId, '3');
  assert.equal(result.scripts[0].isModule, true);
  assert.equal(attachCalls, 0);
});

test('a busy debugger is a named failure, not an empty page', async () => {
  const module = createDeepPerception({
    sessions,
    attach: async () => { throw new Error('Another debugger is already attached to the tab.'); }
  });
  const result = await module.run('browser_script_inventory', { tabId: 7 }, { tab });
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'debugger_busy');
  assert.match(result.recommendedNextAction, /Do not retry/);
});

test('DOM snapshot and framework tree wrap the injected main-world result', async () => {
  const module = createDeepPerception({
    sessions,
    attach: async () => { throw new Error('must not attach'); },
    chromeApi: {
      scripting: {
        executeScript: async ({ func, args }) => {
          if (func.name === 'domSnapshotInPage') {
            return [{ result: { status: 'success', nodes: [{ d: 1, kind: 'element', tag: 'div' }], nodeCount: 1, truncated: false } }];
          }
          const wanted = args?.[0]?.framework || 'auto';
          const trees = wanted === 'auto' || wanted === 'react'
            ? [{ framework: 'react', nodes: [{ d: 0, name: 'App', propKeys: [] }] }]
            : [];
          return [{ result: { status: 'success', detected: [{ name: 'react', version: null, evidence: '__reactFiber$' }], framework: trees.length ? 'react' : null, trees, totalElements: 2, scannedElements: 2 } }];
        }
      }
    }
  });

  const snapshot = await module.run('browser_dom_snapshot', { tabId: 7, maxNodes: 10 }, { tab });
  assert.equal(snapshot.status, 'success');
  assert.equal(snapshot.tabId, 7);
  assert.equal(snapshot.nodes.length, 1);
  assert.match(snapshot.recommendedNextAction, /no ref/);

  const tree = await module.run('browser_framework_tree', { tabId: 7 }, { tab });
  assert.equal(tree.status, 'success');
  assert.equal(tree.framework, 'react');

  const denied = await module.run('browser_framework_tree', { tabId: 7, framework: 'angular' }, { tab });
  assert.equal(denied.status, 'not_found');
  assert.equal(denied.reason, 'framework_not_detected');
});

test('the last sourceMappingURL marker wins', () => {
  assert.equal(sourceMapUrlFromScriptText('code();\n//# sourceMappingURL=first.map\n//# sourceMappingURL=second.map\n'), 'second.map');
  assert.equal(sourceMapUrlFromScriptText('//@ sourceMappingURL=legacy.map'), 'legacy.map');
  assert.equal(sourceMapUrlFromScriptText('const x = 1;'), null);
});

function pageScriptFallback({ scriptUrl = 'https://example.test/assets/app.js', mapUrl = '/assets/app.js.map' } = {}) {
  const fake = makeAttach({ events: false });
  const fetched = [];
  const module = createDeepPerception({
    sessions,
    attach: fake.attach,
    chromeApi: {
      debugger: { onEvent: fake.bus.onEvent },
      scripting: {
        executeScript: async ({ func }) => {
          if (func?.name === 'pageScriptsInPage') {
            return [{ result: { status: 'success', total: 1, scripts: [{ index: 0, src: scriptUrl, inline: false, type: '', textLength: 64 }] } }];
          }
          return [{ result: null }];
        }
      }
    },
    fetchImpl: async url => {
      fetched.push(url);
      if (url === scriptUrl) {
        return { ok: true, status: 200, text: async () => `export const bench = 7319;\n//# sourceMappingURL=${mapUrl}\n` };
      }
      if (url.endsWith('.map')) {
        return { ok: true, status: 200, text: async () => JSON.stringify(sourceMap) };
      }
      return { ok: false, status: 404, text: async () => '' };
    }
  });
  return { module, fetched };
}

test('a page script the debugger replay omitted is still listed from document.scripts', async () => {
  const { module } = pageScriptFallback();
  const listed = await module.run('browser_script_inventory', { tabId: 7, settleMs: 0, urlFilter: 'app.js' }, { tab });
  assert.equal(listed.status, 'success');
  assert.equal(listed.totalScripts, 1);
  assert.equal(listed.cdpScriptCount, 0);
  assert.equal(listed.pageScriptCount, 1);
  assert.equal(listed.matchedCount, 1);
  assert.equal(listed.scripts[0].scriptId, null);
  assert.equal(listed.scripts[0].source, 'page_dom');
  assert.equal(listed.scripts[0].url, 'https://example.test/assets/app.js');
});

test('a page script the debugger replay omitted still resolves its source map', async () => {
  const { module, fetched } = pageScriptFallback();
  const result = await module.run('browser_source_map', {
    tabId: 7, settleMs: 0, url: 'https://example.test/assets/app.js'
  }, { tab });
  assert.equal(result.status, 'success');
  assert.equal(result.scriptSource, 'page_dom');
  assert.equal(result.script.scriptId, null);
  assert.equal(result.script.sourceMapURL, '/assets/app.js.map');
  assert.equal(result.via, 'extension_fetch');
  assert.ok(result.sources.includes('src/app.ts'));
  assert.deepEqual(fetched, ['https://example.test/assets/app.js', 'https://example.test/assets/app.js.map']);
});

test('injection into a restricted page is blocked, not reported as an empty snapshot', async () => {
  const module = createDeepPerception({
    sessions,
    attach: async () => { throw new Error('must not attach'); },
    chromeApi: {
      scripting: {
        executeScript: async () => { throw new Error('Cannot access contents of the page.'); }
      }
    }
  });
  const result = await module.run('browser_dom_snapshot', { tabId: 7 }, { tab });
  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'page_not_scriptable');
});
