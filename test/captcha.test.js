// Character and image-grid captcha contract. Like the slider suite, page.js is
// serialised into the page by chrome.scripting and cannot be imported, so the
// injected half is pinned at the source level; the service half is exercised
// through the real schema, index, guide, candidate normalizer, coordinator and
// MCP content shaping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TOOLS, validateCall } from '../src/tools.js';
import { TOOL_GROUPS, TOOL_ALIASES, groupsForGoal } from '../src/tool-index.js';
import { capabilityGuide } from '../src/capability-guide.js';
import { captchaCandidates, normalizeCaptchaText, captchaReadCharacter } from '../src/captcha-tool.js';
import { mcpToolCall } from '../src/mcp-call.js';

const read = relative => readFileSync(new URL('../' + relative, import.meta.url), 'utf8');
const page = read('extension/page.js');
const worker = read('extension/worker.js');
const server = read('src/server.js');

const CAPTCHA_TOOLS = [
  'browser_captcha_probe',
  'browser_captcha_capture',
  'browser_captcha_read_character',
  'browser_captcha_refresh_verified',
  'browser_captcha_click_verified'
];

function characterProbe(overrides = {}) {
  return {
    status: 'success', found: true, frameId: 0, frameCount: 1,
    challenge: {
      status: 'success', found: true, provider: 'generic', kind: 'character',
      ref: 's1:1@frame0', token: 'tok-1', instruction: { text: '请输入图片中的验证码' }, error: null,
      image: { ref: 's1:2@frame0', selector: 'img.code-img', rect: { x: 10, y: 20, width: 120, height: 40 }, source: 'img element', fingerprint: 'fp-img' },
      input: { ref: 's1:3@frame0', selector: 'input#code', maxLength: 4, valueLength: 0 },
      refresh: { ref: 's1:4@frame0', selector: 'a.refresh', text: '换一张' },
      submit: { ref: 's1:5@frame0', selector: 'button#submit', text: '提交' }, tiles: [], tileCount: 0, selectedCount: 0,
      ...overrides
    }
  };
}

function fakeCapture() {
  return {
    data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    mimeType: 'image/png',
    rect: { x: 10, y: 20, width: 120, height: 40 },
    clip: { x: 2, y: 12, width: 136, height: 56, scale: 6 },
    scale: 6, padding: 8,
    target: { kind: 'element', selector: 'img.code-img', frameId: 0 },
    sideEffects: [], coordinateSpace: 'CSS pixels in the top document'
  };
}

function adapterReturning(result) {
  const calls = [];
  return {
    calls,
    async recognize(input) {
      calls.push(input);
      if (result instanceof Error) throw result;
      return result;
    }
  };
}

test('the five captcha tools are registered, indexed and routed from plain language', () => {
  for (const name of CAPTCHA_TOOLS) {
    const tool = TOOLS.find(entry => entry.name === name);
    assert.ok(tool, `${name} missing from the tool catalogue`);
    assert.ok(tool.inputSchema.required.includes('tabId'), `${name} must bind to one tab`);
    assert.ok(TOOL_GROUPS.some(group => group.tools.includes(name)), `${name} missing from the intent index`);
  }
  for (const name of ['browser_captcha_probe', 'browser_captcha_capture', 'browser_captcha_read_character']) {
    assert.equal(TOOLS.find(entry => entry.name === name).annotations?.readOnlyHint, true, `${name} must be read-only`);
  }
  assert.match(TOOL_ALIASES.act.join(' '), /验证码/);
  assert.match(TOOL_ALIASES.act.join(' '), /recaptcha/);
  assert.ok(groupsForGoal('图片验证码怎么过').some(group => group.id === 'act'));

  const guide = capabilityGuide({ goal: '验证码挡住了' });
  assert.equal(guide.primary.intent, 'captcha-verification');
  assert.equal(guide.focusRequired, false, 'reading and clicking a challenge does not require the foreground');
  assert.ok(guide.primary.tools.includes('browser_captcha_read_character'));
  assert.ok(guide.primary.tools.includes('browser_captcha_click_verified'));
  assert.ok(guide.fallbacks.includes('human-handoff'));

  // A slider goal still routes to the slider intent: the captcha intent must
  // not swallow it through the shared word 验证码.
  const slider = capabilityGuide({ goal: '滑块验证挡住了' });
  assert.equal(slider.primary.intent, 'slider-verification');
});

test('the captcha schemas refuse ranges and shapes the implementation cannot honour', () => {
  assert.doesNotThrow(() => validateCall('browser_captcha_probe', { tabId: 1 }));
  assert.doesNotThrow(() => validateCall('browser_captcha_probe', { tabId: 1, frame: 7, selector: '.g-recaptcha', maxTiles: 16 }));
  // Chrome frame ids are four-digit numbers; a 0..200 range refused the very
  // frame the probe had just reported.
  assert.doesNotThrow(() => validateCall('browser_captcha_probe', { tabId: 1, frame: 1063 }));
  assert.doesNotThrow(() => validateCall('browser_captcha_capture', { tabId: 1, frame: 1063, srcPath: 'https://example.test/frame' }));
  assert.throws(() => validateCall('browser_captcha_probe', {}), /Missing argument: tabId/);
  assert.throws(() => validateCall('browser_captcha_probe', { tabId: 1, maxTiles: 3 }), /Invalid maxTiles/);
  assert.throws(() => validateCall('browser_captcha_probe', { tabId: 1, frame: -1 }), /Invalid frame/);
  assert.throws(() => validateCall('browser_captcha_probe', { tabId: 1, captcha: true }), /Unknown argument: captcha/);

  assert.doesNotThrow(() => validateCall('browser_captcha_read_character', { tabId: 1, expectedLength: 4, charset: 'digits', scale: 8 }));
  assert.throws(() => validateCall('browser_captcha_read_character', { tabId: 1, expectedLength: 13 }), /Invalid expectedLength/);
  assert.throws(() => validateCall('browser_captcha_read_character', { tabId: 1, charset: 'kana' }), /Invalid charset/);

  assert.doesNotThrow(() => validateCall('browser_captcha_click_verified', { tabId: 1, tiles: [0, 4, 15], submit: true }));
  assert.doesNotThrow(() => validateCall('browser_captcha_click_verified', { tabId: 1, points: [{ x: 100, y: 200 }] }));
  assert.throws(() => validateCall('browser_captcha_click_verified', { tabId: 1, tiles: Array.from({ length: 17 }, (_, i) => i) }), /Invalid tiles/);
  assert.throws(() => validateCall('browser_captcha_click_verified', { tabId: 1, points: [{ x: 1001, y: 0 }] }), /Invalid points/);
  assert.throws(() => validateCall('browser_captcha_click_verified', { tabId: 1, settleMs: 5000 }), /Invalid settleMs/);

  assert.doesNotThrow(() => validateCall('browser_captcha_refresh_verified', { tabId: 1, ref: 'a:1@frame2' }));
  assert.throws(() => validateCall('browser_captcha_refresh_verified', { tabId: 1, timeoutMs: 99 }), /Invalid timeoutMs/);
});

test('candidate normalization filters by charset, respects the advertised length and never invents a reading', () => {
  assert.equal(normalizeCaptchaText('A b-1? 2', 'alnum'), 'Ab12');
  assert.equal(normalizeCaptchaText('A b-1? 2', 'digits'), '12');
  assert.equal(normalizeCaptchaText('A b-1? 2', 'alpha'), 'Ab');

  const matched = captchaCandidates({ lines: [{ text: 'AB1 2' }, { text: 'CD' }], expectedLength: 4, charset: 'alnum' });
  assert.equal(matched.text, 'AB12CD');
  assert.equal(matched.lengthMatched, true);
  assert.deepEqual(matched.candidates.filter(item => item.length === 4).map(item => item.text), ['AB12']);

  const unmatched = captchaCandidates({ lines: [{ text: 'X7K9Q' }], expectedLength: 4 });
  assert.equal(unmatched.lengthMatched, false);
  assert.equal(unmatched.candidates[0].source, 'prefix');
  assert.equal(unmatched.candidates[0].text, 'X7K9');

  const free = captchaCandidates({ lines: [{ text: 'abc' }, { text: 'def' }] });
  assert.equal(free.text, 'abcdef');
  assert.equal(free.candidates[0].text, 'abcdef');
  assert.deepEqual(free.candidates.map(item => item.text), ['abcdef', 'abc', 'def']);

  const empty = captchaCandidates({ lines: [{ text: '  ,,  ' }] });
  assert.deepEqual(empty.candidates, []);
  assert.equal(empty.text, null);
});

test('a character read returns candidates with the enlarged image and types nothing', async () => {
  const calls = [];
  const callTool = async (name, args) => {
    calls.push({ name, args });
    if (name === 'browser_captcha_probe') return characterProbe();
    if (name === 'browser_captcha_capture') return fakeCapture();
    throw new Error(`unexpected child call ${name}`);
  };
  const adapter = adapterReturning({
    status: 'success', provider: 'windows_media_ocr', language: 'en-US',
    image: { width: 720, height: 240 },
    lines: [{ text: 'AB1 2' }, { text: 'CD' }], empty: false, elapsedMs: 12
  });
  const result = await captchaReadCharacter({
    args: { tabId: 5, expectedLength: 4, charset: 'alnum', agent: 'tester' },
    callTool, adapter
  });
  assert.equal(result.status, 'success');
  assert.equal(result.ok, true);
  assert.deepEqual(result.candidates.map(item => item.text), ['AB12', 'AB12CD']);
  assert.equal(result.lengthMatched, true);
  assert.equal(result.challenge.token, 'tok-1');
  assert.equal(result.challenge.submit.ref, 's1:5@frame0', 'the read must hand back the submit ref; a second probe costs the code its remaining lifetime');
  assert.equal(result.challenge.refresh.text, '换一张');
  assert.equal(result.image.data, fakeCapture().data);
  assert.equal(result.image.mimeType, 'image/png');
  assert.equal(result.imageWidth, 720);
  assert.match(result.contentTrust, /untrusted webpage pixels/);
  // Only reads: probe + capture. Nothing was typed or submitted.
  assert.deepEqual(calls.map(call => call.name), ['browser_captcha_probe', 'browser_captcha_capture']);
  const captureCall = calls.find(call => call.name === 'browser_captcha_capture');
  assert.equal(captureCall.args.ref, 's1:2@frame0');
  assert.equal(captureCall.args.scale, 6, 'a character read captures at a high scale by default');
  assert.equal(captureCall.args.agent, 'tester', 'routing must survive the coordinator');
  // OCR sees the captured pixels, never a viewport: there is no page coordinate to map.
  assert.equal(adapter.calls.length, 1);
  assert.equal(adapter.calls[0].base64, fakeCapture().data);
  assert.equal(adapter.calls[0].viewport, null);
});

test('a grid challenge is refused as unsupported with the grid route named', async () => {
  const calls = [];
  const callTool = async (name) => {
    calls.push(name);
    return characterProbe({ kind: 'grid', image: null, tiles: [{ index: 0 }], tileCount: 16 });
  };
  const result = await captchaReadCharacter({ args: { tabId: 5 }, callTool, adapter: adapterReturning({ status: 'success', lines: [] }) });
  assert.equal(result.status, 'unsupported');
  assert.equal(result.kind, 'grid');
  assert.equal(result.reason, 'challenge_kind_not_character');
  assert.match(result.recommendedNextAction, /browser_captcha_capture/);
  assert.match(result.recommendedNextAction, /browser_captcha_click_verified/);
  assert.deepEqual(calls, ['browser_captcha_probe'], 'a grid must not be sent to character OCR');
});

test('absent, failing and unreadable challenges are reported honestly', async () => {
  const notFound = await captchaReadCharacter({
    args: { tabId: 5 },
    callTool: async () => ({ status: 'success', found: false, frames: [], challenge: null }),
    adapter: adapterReturning({ status: 'success', lines: [] })
  });
  assert.equal(notFound.status, 'not_found');
  assert.match(notFound.recommendedNextAction, /trigger the action that opens it/i);

  const probeThrow = await captchaReadCharacter({
    args: { tabId: 5 },
    callTool: async () => { throw new Error('socket closed'); },
    adapter: adapterReturning({ status: 'success', lines: [] })
  });
  assert.equal(probeThrow.status, 'failed');
  assert.equal(probeThrow.retryable, true);
  assert.equal(probeThrow.reason, 'captcha_probe_failed');

  const unavailable = await captchaReadCharacter({
    args: { tabId: 5 },
    callTool: async name => name === 'browser_captcha_probe' ? characterProbe() : fakeCapture(),
    adapter: adapterReturning({ status: 'unavailable', reason: 'ocr_language_unavailable', availableLanguages: ['en-US'], image: { width: 10, height: 10 } })
  });
  assert.equal(unavailable.status, 'unavailable');
  assert.equal(unavailable.retryable, false);
  assert.equal(unavailable.image.data, fakeCapture().data, 'the image must still be attached for a visual read');
  assert.match(unavailable.recommendedNextAction, /Windows OCR is unavailable/);

  const empty = await captchaReadCharacter({
    args: { tabId: 5 },
    callTool: async name => name === 'browser_captcha_probe' ? characterProbe() : fakeCapture(),
    adapter: adapterReturning({ status: 'success', image: { width: 10, height: 10 }, lines: [], empty: true })
  });
  assert.equal(empty.status, 'partial');
  assert.equal(empty.reason, 'no_characters_recognized');
  assert.equal(empty.retryable, true);
  assert.match(empty.recommendedNextAction, /read the attached enlarged image/);
});

test('the page-side captcha block observes instead of assuming', () => {
  assert.match(page, /const CAPTCHA_TILE_SELECTORS = 'td\.rc-imageselect-tile/);
  // Cross-frame refs are stripped inside the owning frame before lookup.
  assert.match(page, /const bareRef = ref => typeof ref === 'string' \? ref\.replace\(\/@frame\\d\+\$\/, ''\) : ref;/);
  assert.match(page, /state\?\.refs\.get\(bareRef\(ref\)\)/);
  // Token identity deliberately excludes the selection state.
  assert.match(page, /const token = hashToken\(JSON\.stringify\(\[/);
  assert.match(page, /selectionChanges/);
  // A status/refresh read rebuilds the report from the root alone, so it must
  // re-detect the character pair there; otherwise the same widget hashes as
  // 'unknown' on one route and 'character' on the other, and every refresh
  // looks like a new challenge. Caught by the local captcha range.
  assert.match(page, /const local = captchaCharacterOf\(root\);/);
  assert.match(page, /const imageFingerprint = image \? captchaSourceFingerprint\(image\.src\) : '';/);
  assert.match(page, /tiles\.map\(tile => tile\.sourceFingerprint\)\.join\(','\),\s*imageFingerprint,/);
  // A re-render between probe and click is refused, not clicked blind.
  assert.match(page, /reason: 'tile_count_changed'/);
  assert.match(page, /expectedTileCount/);
  // Per-click judgement: synchronous first, then a bounded wait.
  assert.match(page, /if \(captchaTileSignature\(el\) !== beforeSignature\) return \{ changed: true, by: 'tile_state', synchronous: true \};/);
  assert.match(page, /stopped = \{ index, reason: 'click_not_observed' \}/);
  // Synthetic page events, and the note says the site still judges the answer.
  assert.match(page, /el\.dispatchEvent\(new MouseEvent\('mousedown', \{ \.\.\.base, buttons: 1 \}\)\)/);
  assert.match(page, /status: stopped \? 'uncertain' : 'clicked'/);
  // Refresh clicks once; the verdict is polled by the worker, not by page timers.
  assert.match(page, /beforeToken: before\.token/);
  assert.match(page, /Refresh was clicked once/);
});

test('the worker probes every frame, decorates refs and never replays an unobserved click', () => {
  assert.match(worker, /function decorateFrameRefs\(value, frameId\)/);
  assert.match(worker, /key === 'ref' && typeof item === 'string' && !item\.includes\('@frame'\)/);
  assert.match(worker, /injectAllFrames\(tab\.id, pageOperation, \['browser_captcha_probe'/);
  // A challenge inside another frame is captured through its host iframe box.
  assert.match(worker, /const host = await page\('browser_captcha_host'/);
  assert.match(worker, /kind: 'host_iframe'/);
  // Refresh polls with worker timers so a hidden tab's throttled timers do not matter.
  const refreshReason = worker.indexOf("reason: 'refresh_not_observed'");
  assert.ok(refreshReason > 0);
  const refreshVerdict = worker.slice(Math.max(0, refreshReason - 260), refreshReason + 120);
  assert.match(refreshVerdict, /retryable: false/);
  // The click sequence verifies the token and tile count, and an unobserved
  // click is uncertain and non-retryable.
  assert.match(worker, /reason: 'challenge_token_changed'/);
  const clickReason = worker.indexOf("reason: 'captcha_click_not_observed'");
  assert.ok(clickReason > 0);
  const clickVerdict = worker.slice(Math.max(0, clickReason - 260), clickReason + 120);
  assert.match(clickVerdict, /retryable: false/);
  // The verdict poll distinguishes closed, new round, rejection and no signal.
  assert.match(worker, /challenge_closed/);
  assert.match(worker, /status: 'next_round'/);
  assert.match(worker, /outcome: 'rejected'/);
  assert.match(worker, /reason: 'captcha_outcome_not_observed'/);
  // A stale ref that "closed" is disambiguated by one rediscovery read.
  assert.match(worker, /if \(again\?\.found === true\) phase = 'new_round';/);
  // The page-level probe returns the challenge report itself; only the worker's
  // aggregated reply wraps it as `challenge`. Reading pre.challenge made the
  // live range report challenge_not_found for a widget the same probe found.
  assert.equal(worker.match(/const challenge = pre\?\.found === true \? pre : null;/g)?.length, 2);
  assert.doesNotMatch(worker, /pre\?\.challenge/);
  assert.doesNotMatch(worker, /again\?\.challenge/);
  // The character read is coordinated on the service side, above the queue.
  assert.match(server, /if \(name === 'browser_captcha_read_character'\)/);
  assert.match(server, /captchaReadCharacter\(\{/);
});

test('MCP clients receive the picture as an image block and metadata without base64', async () => {
  const capture = fakeCapture();
  const rawCall = async name => name === 'browser_screenshot'
    ? { data: capture.data, mimeType: 'image/png' }
    : name === 'browser_captcha_capture' || name === 'browser_capture_element'
      ? { ...capture }
      : name === 'browser_captcha_read_character'
        ? { status: 'success', candidates: [{ text: 'AB12' }], image: { ...capture } }
        : { status: 'success', ok: true };

  const shot = await mcpToolCall('browser_screenshot', {}, rawCall);
  assert.deepEqual(shot.content.map(block => block.type), ['image']);

  for (const name of ['browser_capture_element', 'browser_captcha_capture']) {
    const reply = await mcpToolCall(name, {}, rawCall);
    assert.deepEqual(reply.content.map(block => block.type), ['image', 'text'], `${name} must return the image plus metadata`);
    assert.equal(reply.content[0].data, capture.data);
    assert.equal(reply.content[0].mimeType, 'image/png');
    assert.ok(!reply.content[1].text.includes(capture.data), `${name} metadata must not repeat the base64 payload`);
    const meta = JSON.parse(reply.content[1].text);
    assert.equal(meta.scale, 6);
  }

  const read = await mcpToolCall('browser_captcha_read_character', {}, async () => ({
    status: 'success', candidates: [{ text: 'AB12' }], image: { ...capture }
  }));
  assert.deepEqual(read.content.map(block => block.type), ['image', 'text']);
  assert.equal(read.content[0].data, capture.data);
  const readMeta = JSON.parse(read.content[1].text);
  assert.equal(readMeta.status, 'success');
  assert.equal(readMeta.image.data, undefined);
  assert.equal(readMeta.candidates[0].text, 'AB12');

  const plain = await mcpToolCall('browser_read', {}, rawCall);
  assert.deepEqual(plain.content.map(block => block.type), ['text']);
});
