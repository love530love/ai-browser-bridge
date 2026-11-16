import test from 'node:test';
import assert from 'node:assert/strict';
import { ocrTab } from '../src/ocr-tool.js';

function pngBuffer(width, height) {
  const buffer = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

function successShot(width = 1280, height = 720) {
  return {
    status: 'success',
    mimeType: 'image/png',
    data: pngBuffer(width, height).toString('base64'),
    sideEffects: [{ type: 'screencast_warmup' }],
    warmup: { used: true }
  };
}

function pageProbe() {
  return {
    readyState: 'complete',
    visibilityState: 'visible',
    focused: false,
    viewport: { width: 640, height: 360 },
    scrollX: 0,
    scrollY: 12
  };
}

function successRecognition(overrides = {}) {
  return {
    status: 'success',
    ok: true,
    provider: 'windows_media_ocr',
    language: 'en-US',
    requestedLanguage: 'en-US',
    availableLanguages: ['en-US'],
    image: { width: 1280, height: 720, mimeType: 'image/png' },
    lines: [{
      index: 0,
      text: 'Pay now',
      pixelRect: { x: 200, y: 100, width: 200, height: 40 },
      rect: { x: 100, y: 50, width: 100, height: 20 },
      point: { x: 234.4, y: 166.7 }
    }],
    coordinatesAvailable: true,
    scale: { x: 2, y: 2 },
    lineCount: 1,
    text: 'Pay now',
    empty: false,
    truncated: false,
    elapsedMs: 120,
    nextStep: null,
    ...overrides
  };
}

test('ocrTab coordinates a background-safe read and only records metadata', async () => {
  const calls = [];
  const entries = [];
  const adapter = {
    recognize: async input => {
      adapter.seen = input;
      return successRecognition();
    }
  };
  const callTool = async (name, args) => {
    calls.push({ name, args });
    if (name === 'browser_screenshot') return successShot();
    if (name === 'browser_debug') return pageProbe();
    throw new Error(`unexpected tool ${name}`);
  };
  const store = { recordOcrRun: entry => { entries.push(entry); return true; } };

  const result = await ocrTab({
    args: { tabId: 7, agent: 'agent-x', hostId: 'host-1', language: 'en-US', maxLines: 5, includeWords: true },
    callTool,
    adapter,
    store
  });

  assert.deepEqual(calls.map(call => call.name), ['browser_screenshot', 'browser_debug']);
  for (const call of calls) {
    assert.deepEqual(call.args, { tabId: 7, agent: 'agent-x', hostId: 'host-1' });
  }
  assert.equal(adapter.seen.viewport.width, 640);
  assert.equal(adapter.seen.language, 'en-US');
  assert.equal(adapter.seen.maxLines, 5);
  assert.equal(adapter.seen.includeWords, true);

  assert.equal(result.status, 'success');
  assert.equal(result.ok, true);
  assert.equal(result.tabId, 7);
  assert.equal(result.text, 'Pay now');
  assert.equal(result.lineCount, 1);
  assert.equal(result.noRefs, true);
  assert.equal(result.nextStep, null);
  assert.match(result.scope, /current viewport pixels only/);
  assert.match(result.contentTrust, /untrusted webpage pixels/);
  assert.match(result.actionSafety, /browser_action_verified/);
  assert.match(result.recommendedNextAction, /browser_prepare_coordinate/);
  assert.equal(result.viewport.source, 'browser_debug');
  assert.match(result.coordinateSpace.normalized, /0\.\.1000/);
  assert.deepEqual(result.screenshot.sideEffects, [{ type: 'screencast_warmup' }]);
  assert.equal(result.page.readyState, 'complete');

  assert.equal(result.ledgerRecorded, true);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].status, 'success');
  assert.equal(entries[0].provider, 'windows_media_ocr');
  assert.equal(entries[0].language, 'en-US');
  assert.equal(entries[0].lineCount, 1);
  assert.equal(entries[0].imageWidth, 1280);
  assert.equal(entries[0].imageHeight, 720);
  assert.equal(entries[0].truncated, false);
  assert.equal('text' in entries[0], false);
  assert.doesNotMatch(JSON.stringify(entries), /Pay now/);
});

test('ocrTab downgrades a successful recognition without a viewport to partial', async () => {
  const entries = [];
  const adapter = {
    recognize: async () => successRecognition({
      coordinatesAvailable: false,
      scale: null,
      lines: [{ index: 0, text: 'Pay now', pixelRect: { x: 200, y: 100, width: 200, height: 40 }, rect: null, point: null }]
    })
  };
  const callTool = async name => {
    if (name === 'browser_screenshot') return successShot(100, 100);
    if (name === 'browser_debug') throw new Error('debug unavailable');
    throw new Error(`unexpected tool ${name}`);
  };
  const result = await ocrTab({
    args: { tabId: 3 },
    callTool,
    adapter,
    store: { recordOcrRun: entry => { entries.push(entry); return true; } }
  });

  assert.equal(result.status, 'partial');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'viewport_unavailable');
  assert.equal(result.text, 'Pay now');
  assert.equal(result.viewport, null);
  assert.equal(result.page, null);
  assert.equal(result.coordinateSpace.available, false);
  assert.match(result.recommendedNextAction, /viewport was unavailable/);
  assert.equal(entries[0].status, 'partial');
});

test('ocrTab propagates a waiting screenshot without running OCR', async () => {
  let adapterCalled = false;
  const entries = [];
  const callTool = async () => ({
    status: 'waiting',
    reason: 'screenshot_pending',
    retryable: true,
    recommendedNextAction: 'Poll browser_wait_until_ready.'
  });
  const result = await ocrTab({
    args: { tabId: 9 },
    callTool,
    adapter: { recognize: async () => { adapterCalled = true; throw new Error('must not run'); } },
    store: { recordOcrRun: entry => { entries.push(entry); return true; } }
  });

  assert.equal(adapterCalled, false);
  assert.equal(result.status, 'waiting');
  assert.equal(result.ok, false);
  assert.equal(result.screenshotStatus, 'waiting');
  assert.equal(result.screenshotRecommendedNextAction, 'Poll browser_wait_until_ready.');
  assert.match(result.recommendedNextAction, /Preserve the task/);
  assert.equal(result.nextStep, null);
  assert.equal(entries[0].status, 'waiting');
});

test('ocrTab propagates a denied screenshot and states that nothing was recognized', async () => {
  const callTool = async () => ({ status: 'denied', reason: 'tool_not_allowed' });
  const result = await ocrTab({ args: { tabId: 1 }, callTool, adapter: { recognize: async () => { throw new Error('must not run'); } } });
  assert.equal(result.status, 'denied');
  assert.equal(result.ok, false);
  assert.equal(result.ledgerRecorded, false);
  assert.match(result.recommendedNextAction, /denied by agent policy/);
});

test('ocrTab refuses an unusable screenshot result without claiming a page has no text', async () => {
  const callTool = async () => null;
  const result = await ocrTab({ args: { tabId: 1 }, callTool, adapter: { recognize: async () => { throw new Error('must not run'); } } });
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'screenshot_invalid_result');
  assert.equal(result.dispatched, false);
  assert.match(result.recommendedNextAction, /not evidence that the page has no text/);
});

test('ocrTab turns an adapter exception into a structured failure', async () => {
  const entries = [];
  const result = await ocrTab({
    args: { tabId: 2 },
    callTool: async name => (name === 'browser_screenshot' ? successShot() : pageProbe()),
    adapter: { recognize: async () => { throw new Error('spawn failed'); } },
    store: { recordOcrRun: entry => { entries.push(entry); return true; } }
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'ocr_adapter_error');
  assert.equal(result.retryable, false);
  assert.match(result.detail, /spawn failed/);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].status, 'failed');
});

test('ocrTab reports an empty successful OCR honestly', async () => {
  const result = await ocrTab({
    args: { tabId: 4 },
    callTool: async name => (name === 'browser_screenshot' ? successShot() : pageProbe()),
    adapter: {
      recognize: async () => successRecognition({
        lines: [], text: '', lineCount: 0, empty: true, coordinatesAvailable: true
      })
    }
  });
  assert.equal(result.status, 'success');
  assert.equal(result.ok, true);
  assert.equal(result.empty, true);
  assert.match(result.recommendedNextAction, /found no painted text/);
});

test('ocrTab forwards no agent or hostId when the caller did not supply them', async () => {
  const seen = [];
  const callTool = async (name, args) => {
    seen.push(args);
    return name === 'browser_screenshot' ? successShot() : pageProbe();
  };
  await ocrTab({ args: { tabId: 5, agent: '   ' }, callTool, adapter: { recognize: async () => successRecognition() } });
  assert.deepEqual(seen[0], { tabId: 5 });
  assert.deepEqual(seen[1], { tabId: 5 });
});
