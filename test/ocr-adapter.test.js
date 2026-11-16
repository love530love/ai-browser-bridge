import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOcrAdapter, mapOcrLines, pngDimensions } from '../src/ocr-adapter.js';

function pngBuffer(width, height) {
  const buffer = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  buffer.writeUInt8(8, 24);
  buffer.writeUInt8(6, 25);
  return buffer;
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'aib-ocr-'));
}

function stubRunner(script) {
  const calls = [];
  const runner = async options => {
    calls.push({ ...options, existedDuringRun: existsSync(options.imagePath) });
    return script(options);
  };
  runner.calls = calls;
  return runner;
}

test('pngDimensions accepts only a real PNG IHDR', () => {
  assert.deepEqual(pngDimensions(pngBuffer(1280, 720)), { width: 1280, height: 720 });
  assert.equal(pngDimensions(Buffer.alloc(10)), null);
  assert.equal(pngDimensions(Buffer.from('not a png at all, just text bytes')), null);
  const badSignature = pngBuffer(10, 10);
  badSignature[1] = 0;
  assert.equal(pngDimensions(badSignature), null);
  const badChunk = pngBuffer(10, 10);
  badChunk.write('IDAT', 12, 'ascii');
  assert.equal(pngDimensions(badChunk), null);
  assert.equal(pngDimensions(pngBuffer(0, 10)), null);
  assert.equal(pngDimensions('not a buffer'), null);
});

test('mapOcrLines converts pixels to CSS rects and 0..1000 points', () => {
  const mapped = mapOcrLines({
    image: { width: 1280, height: 720 },
    viewport: { width: 640, height: 360 },
    lines: [{
      text: 'Click',
      pixelRect: { x: 200, y: 100, width: 200, height: 40 },
      words: [{ text: 'Click', pixelRect: { x: 200, y: 100, width: 80, height: 40 } }]
    }]
  });
  assert.equal(mapped.coordinatesAvailable, true);
  assert.deepEqual(mapped.scale, { x: 2, y: 2 });
  const line = mapped.lines[0];
  assert.deepEqual(line.pixelRect, { x: 200, y: 100, width: 200, height: 40 });
  assert.deepEqual(line.rect, { x: 100, y: 50, width: 100, height: 20 });
  assert.deepEqual(line.point, { x: 234.4, y: 166.7 });
  assert.deepEqual(line.words[0].rect, { x: 100, y: 50, width: 40, height: 20 });
  assert.deepEqual(line.words[0].point, { x: 187.5, y: 166.7 });
});

test('mapOcrLines keeps pixel boxes but no CSS or normalized point without a viewport', () => {
  const mapped = mapOcrLines({
    image: { width: 1280, height: 720 },
    viewport: null,
    lines: [{ text: 'Lonely', pixelRect: { x: 20, y: 30, width: 40, height: 10 } }]
  });
  assert.equal(mapped.coordinatesAvailable, false);
  assert.equal(mapped.scale, null);
  assert.deepEqual(mapped.lines[0].rect, null);
  assert.equal(mapped.lines[0].point, null);
  assert.deepEqual(mapped.lines[0].pixelRect, { x: 20, y: 30, width: 40, height: 10 });
});

test('mapOcrLines clamps a box that runs past the viewport edge', () => {
  const mapped = mapOcrLines({
    image: { width: 640, height: 360 },
    viewport: { width: 640, height: 360 },
    lines: [{ text: 'Edge', pixelRect: { x: 600, y: 10, width: 200, height: 40 } }]
  });
  assert.deepEqual(mapped.lines[0].rect, { x: 600, y: 10, width: 40, height: 40 });
});

test('recognize runs locally, maps lines and deletes the temporary screenshot', async t => {
  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const runner = stubRunner(() => ({
    code: 0,
    stderr: '',
    stdout: [
      'warning: something harmless',
      JSON.stringify({
        language: 'en-US',
        requestedLanguage: '',
        availableLanguages: ['en-US', 'zh-Hans-CN'],
        width: 1280,
        height: 720,
        lines: [{
          text: '  Submit  ',
          x: 200, y: 100, width: 200, height: 40,
          words: [{ text: 'Submit', x: 200, y: 100, width: 80, height: 40 }]
        }]
      })
    ].join('\r\n')
  }));
  const adapter = createOcrAdapter({ tempDir: dir, runner });
  const result = await adapter.recognize({
    base64: pngBuffer(1280, 720).toString('base64'),
    language: 'en-US',
    includeWords: true,
    viewport: { width: 640, height: 360 }
  });
  assert.equal(runner.calls.length, 1);
  assert.equal(runner.calls[0].existedDuringRun, true);
  assert.equal(result.status, 'success');
  assert.equal(result.ok, true);
  assert.equal(result.provider, 'windows_media_ocr');
  assert.equal(result.language, 'en-US');
  assert.deepEqual(result.availableLanguages, ['en-US', 'zh-Hans-CN']);
  assert.deepEqual(result.image, { width: 1280, height: 720, mimeType: 'image/png' });
  assert.equal(result.coordinatesAvailable, true);
  assert.equal(result.lineCount, 1);
  assert.equal(result.lines[0].text, 'Submit');
  assert.deepEqual(result.lines[0].point, { x: 234.4, y: 166.7 });
  assert.equal(result.text, 'Submit');
  assert.equal(result.empty, false);
  assert.equal(result.truncated, false);
  assert.equal(result.nextStep, null);
  assert.equal(result.cleanup.tempFileRemoved, true);
  assert.deepEqual(readdirSync(dir), []);
});

test('recognize compacts only the spacing Windows inserts between Han characters', async t => {
  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const runner = stubRunner(() => ({
    code: 0,
    stderr: '',
    stdout: JSON.stringify({
      language: 'zh-Hans-CN', width: 100, height: 100,
      lines: [
        { text: '工 具 & 平 台', x: 0, y: 0, width: 80, height: 10 },
        { text: 'Log in now', x: 0, y: 20, width: 80, height: 10 }
      ]
    })
  }));
  const adapter = createOcrAdapter({ tempDir: dir, runner });
  const result = await adapter.recognize({ base64: pngBuffer(100, 100).toString('base64') });
  assert.equal(result.lines[0].text, '工具 & 平台');
  assert.equal(result.lines[1].text, 'Log in now');
  assert.match(result.textNormalization, /Han characters/);
});

test('recognize reports a missing language engine without retrying', async t => {
  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const runner = stubRunner(() => ({
    code: 3,
    stderr: '',
    stdout: JSON.stringify({ error: 'ocr_language_unavailable', availableLanguages: ['en-US'] })
  }));
  const adapter = createOcrAdapter({ tempDir: dir, runner });
  const result = await adapter.recognize({
    base64: pngBuffer(100, 100).toString('base64'),
    language: 'de-DE'
  });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.retryable, false);
  assert.equal(result.reason, 'ocr_language_unavailable');
  assert.deepEqual(result.availableLanguages, ['en-US']);
  assert.equal(result.requestedLanguage, 'de-DE');
  assert.equal(result.cleanup.tempFileRemoved, true);
});

test('recognize reports a timeout and still deletes the screenshot', async t => {
  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const runner = stubRunner(() => ({ timedOut: true, code: null, stdout: '', stderr: '' }));
  const adapter = createOcrAdapter({ tempDir: dir, runner });
  const result = await adapter.recognize({ base64: pngBuffer(50, 50).toString('base64') });
  assert.equal(result.status, 'timeout');
  assert.equal(result.retryable, true);
  assert.equal(result.reason, 'ocr_timeout');
  assert.equal(result.timeoutMs, 25000);
  assert.equal(result.cleanup.tempFileRemoved, true);
});

test('recognize refuses a non-PNG or unparseable capture without running OCR', async t => {
  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const runner = stubRunner(() => ({ code: 0, stdout: '{}', stderr: '' }));
  const adapter = createOcrAdapter({ tempDir: dir, runner });

  const jpeg = await adapter.recognize({ base64: pngBuffer(10, 10).toString('base64'), mimeType: 'image/jpeg' });
  assert.equal(jpeg.reason, 'unsupported_image_type');
  const invalid = await adapter.recognize({ base64: Buffer.from('nope').toString('base64') });
  assert.equal(invalid.reason, 'invalid_png');
  const missing = await adapter.recognize({ base64: '' });
  assert.equal(missing.reason, 'screenshot_missing');
  assert.equal(runner.calls.length, 0);
});

test('recognize never echoes stdout when the OCR process prints garbage', async t => {
  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const runner = stubRunner(() => ({ code: 0, stdout: 'secret-recognized-text-without-json', stderr: '' }));
  const adapter = createOcrAdapter({ tempDir: dir, runner });
  const result = await adapter.recognize({ base64: pngBuffer(10, 10).toString('base64') });
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'ocr_output_unparseable');
  assert.equal(result.stderrPresent, false);
  assert.doesNotMatch(JSON.stringify(result), /secret-recognized-text/);
  assert.equal(result.cleanup.tempFileRemoved, true);
  assert.deepEqual(readdirSync(dir), []);
});

test('recognize rejects a capture whose OCR dimensions disagree with its PNG', async t => {
  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const runner = stubRunner(() => ({
    code: 0,
    stderr: '',
    stdout: JSON.stringify({ language: 'en-US', width: 99, height: 99, lines: [] })
  }));
  const adapter = createOcrAdapter({ tempDir: dir, runner });
  const result = await adapter.recognize({ base64: pngBuffer(100, 100).toString('base64') });
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'ocr_dimensions_mismatch');
  assert.deepEqual(result.screenshot, { width: 100, height: 100 });
});

test('recognize caps lines and text while reporting exactly what was cut', async t => {
  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lines = Array.from({ length: 5 }, (_, index) => ({
    text: `line-${index}`,
    x: 0, y: index * 10, width: 40, height: 8
  }));
  const runner = stubRunner(() => ({
    code: 0,
    stderr: '',
    stdout: JSON.stringify({ language: 'en-US', width: 100, height: 100, lines })
  }));
  const adapter = createOcrAdapter({ tempDir: dir, runner });
  const result = await adapter.recognize({
    base64: pngBuffer(100, 100).toString('base64'),
    maxLines: 2,
    viewport: { width: 100, height: 100 }
  });
  assert.equal(result.lineCount, 2);
  assert.equal(result.text, 'line-0\nline-1');
  assert.equal(result.truncated, true);
  assert.deepEqual(result.truncation, { lines: true, wordsPerLine: false, text: false });
});

test('stale temporary screenshots from a previous run are pruned', async t => {
  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stale = join(dir, 'ocr-stale.png');
  writeFileSync(stale, pngBuffer(10, 10));
  const old = new Date(Date.now() - 7 * 60 * 60 * 1000);
  utimesSync(stale, old, old);
  const runner = stubRunner(() => ({
    code: 0,
    stderr: '',
    stdout: JSON.stringify({ language: 'en-US', width: 10, height: 10, lines: [] })
  }));
  const adapter = createOcrAdapter({ tempDir: dir, runner });
  const result = await adapter.recognize({ base64: pngBuffer(10, 10).toString('base64') });
  assert.equal(result.status, 'success');
  assert.equal(result.empty, true);
  assert.equal(existsSync(stale), false);
});
