// Local, weight-free OCR perception.
//
// Windows.Media.Ocr is part of Windows and needs no model download, API key or
// network call. This module turns a fresh screenshot into untrusted text with
// pixel boxes, then maps those boxes onto the visible viewport in both CSS
// pixels and the 0..1000 units used by the coordinate tools.
//
// It is a perception route, never an action: recognized text has no DOM ref,
// no semantic role and no proof of clickability. A caller must confirm the
// point with browser_prepare_coordinate and perform any write through a
// _verified variant.
//
// The screenshot is written to a mode-0600 temporary file only because the
// PowerShell OCR API reads files, and it is deleted in a finally block.
// Recognized text is returned to the caller and never written to the local
// ledger or to logs.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_SCRIPT_PATH = fileURLToPath(new URL('../scripts/windows-ocr.ps1', import.meta.url));
const DEFAULT_TIMEOUT_MS = 25000;
const OUTPUT_LIMIT = 16 * 1024 * 1024;
const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
const MAX_TEXT_CHARS = 20000;
const MAX_WORDS_PER_LINE = 40;
const STALE_TEMP_MS = 6 * 60 * 60 * 1000;
const HAN = '\\u3400-\\u9FFF\\uF900-\\uFAFF';
const HAN_GAP = new RegExp(`(?<=[${HAN}]) +(?=[${HAN}])`, 'g');

// Windows.Media.Ocr separates every Han glyph with a space, so "工具" arrives
// as "工 具" and a caller searching for the visible label cannot find it. Only
// the gap between two adjacent Han characters is removed; Latin spacing, which
// is meaningful, is left untouched.
function compactHanSpacing(text) {
  return text.replace(HAN_GAP, '');
}

function resolvePowerShell() {
  const root = process.env.SystemRoot ?? process.env.WINDIR ?? '';
  if (root) {
    const candidate = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    if (existsSync(candidate)) return candidate;
  }
  return 'powershell.exe';
}

function lastJsonLine(text) {
  const lines = String(text ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!lines[index].startsWith('{')) continue;
    try { return JSON.parse(lines[index]); } catch { /* keep looking upwards */ }
  }
  return null;
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function pixelRect(rect) {
  if (!rect || !finite(rect.x) || !finite(rect.y) || !finite(rect.width) || !finite(rect.height)) return null;
  if (rect.width <= 0 || rect.height <= 0) return null;
  return { x: round1(rect.x), y: round1(rect.y), width: round1(rect.width), height: round1(rect.height) };
}

function toCssRect(rect, scaleX, scaleY, viewport) {
  if (!rect) return null;
  const x = clamp(rect.x / scaleX, 0, viewport.width);
  const y = clamp(rect.y / scaleY, 0, viewport.height);
  const width = clamp(rect.width / scaleX, 0, viewport.width - x);
  const height = clamp(rect.height / scaleY, 0, viewport.height - y);
  return { x: round1(x), y: round1(y), width: round1(width), height: round1(height) };
}

function toPoint(cssRect, viewport) {
  if (!cssRect || viewport.width <= 0 || viewport.height <= 0) return null;
  return {
    x: round1(clamp(((cssRect.x + cssRect.width / 2) / viewport.width) * 1000, 0, 1000)),
    y: round1(clamp(((cssRect.y + cssRect.height / 2) / viewport.height) * 1000, 0, 1000))
  };
}

// PNG is the only screenshot format the bridge produces. Reading the IHDR
// directly avoids an image dependency, and the OCR result's own width/height is
// compared against it so a mismatched capture cannot silently shift every box.
export function pngDimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return null;
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!signature.every((byte, index) => buffer[index] === byte)) return null;
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (!width || !height) return null;
  return { width, height };
}

export function mapOcrLines({ lines = [], image = null, viewport = null } = {}) {
  const width = finite(viewport?.width) && viewport.width > 0 ? viewport.width : null;
  const height = finite(viewport?.height) && viewport.height > 0 ? viewport.height : null;
  const imageWidth = finite(image?.width) && image.width > 0 ? image.width : null;
  const imageHeight = finite(image?.height) && image.height > 0 ? image.height : null;
  const scale = imageWidth && imageHeight && width && height
    ? { x: imageWidth / width, y: imageHeight / height }
    : null;
  const safeViewport = scale ? { width, height } : null;

  const mapped = lines.map((line, index) => {
    const raw = pixelRect(line.pixelRect);
    const rect = scale && raw ? toCssRect(raw, scale.x, scale.y, safeViewport) : null;
    const point = rect ? toPoint(rect, safeViewport) : null;
    const words = Array.isArray(line.words)
      ? line.words.map(word => {
        const wordRaw = pixelRect(word.pixelRect);
        const wordRect = scale && wordRaw ? toCssRect(wordRaw, scale.x, scale.y, safeViewport) : null;
        return {
          text: String(word.text ?? ''),
          pixelRect: wordRaw,
          rect: wordRect,
          point: wordRect ? toPoint(wordRect, safeViewport) : null
        };
      })
      : undefined;
    return {
      index,
      text: String(line.text ?? ''),
      pixelRect: raw,
      rect,
      point,
      ...(words ? { words } : {})
    };
  });

  return {
    lines: mapped,
    coordinatesAvailable: !!scale,
    scale: scale ? { x: round1(scale.x), y: round1(scale.y) } : null
  };
}

function defaultRunner({ scriptPath, powershellPath, imagePath, language, timeoutMs }) {
  return new Promise(resolve => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, ...result });
    };
    let child;
    try {
      const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-ImagePath', imagePath];
      if (language) args.push('-Language', language);
      child = spawn(powershellPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      finish({ code: null, error: error?.message ?? String(error) });
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      finish({ code: null, timedOut: true });
    }, timeoutMs);
    child.stdout?.on('data', chunk => { stdout = (stdout + chunk.toString('utf8')).slice(-OUTPUT_LIMIT); });
    child.stderr?.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-OUTPUT_LIMIT); });
    child.on('error', error => finish({ code: null, error: error?.message ?? String(error) }));
    child.on('close', code => finish({ code }));
  });
}

function briefMessage(value, imagePath) {
  const text = String(value ?? '').replaceAll(String(imagePath ?? ''), '<temp-image>').replace(/\s+/g, ' ').trim();
  return text.slice(0, 300) || null;
}

function languageList(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(item => typeof item === 'string' && item.length <= 40).slice(0, 50);
}

async function removeTempFile(file) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await unlink(file);
      return true;
    } catch (error) {
      if (error?.code === 'ENOENT') return true;
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 40));
    }
  }
  return false;
}

export function createOcrAdapter({
  scriptPath = DEFAULT_SCRIPT_PATH,
  powershellPath = resolvePowerShell(),
  tempDir = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  runner = defaultRunner
} = {}) {
  let staleCleaned = false;

  const cleanupStale = () => {
    if (staleCleaned || !tempDir) return;
    staleCleaned = true;
    try {
      const now = Date.now();
      for (const name of readdirSync(tempDir)) {
        if (!name.startsWith('ocr-') || !name.endsWith('.png')) continue;
        const file = join(tempDir, name);
        try {
          if (now - statSync(file).mtimeMs > STALE_TEMP_MS) unlinkSync(file);
        } catch { /* another process may own it */ }
      }
    } catch { /* the directory may not exist yet */ }
  };

  return {
    provider: 'windows_media_ocr',
    scriptPath,
    tempDir,

    async recognize({
      base64 = '',
      mimeType = 'image/png',
      language = '',
      maxLines = 100,
      includeWords = false,
      viewport = null
    } = {}) {
      const startedAt = Date.now();
      const requestedLanguage = typeof language === 'string' ? language.trim().slice(0, 35) : '';
      const resultLimit = clamp(Math.trunc(Number(maxLines) || 100), 1, 400);

      if (mimeType !== 'image/png') {
        return { status: 'failed', retryable: false, reason: 'unsupported_image_type', provider: 'windows_media_ocr', imageMimeType: String(mimeType).slice(0, 60), nextStep: null };
      }
      if (typeof base64 !== 'string' || !base64) {
        return { status: 'failed', retryable: false, reason: 'screenshot_missing', provider: 'windows_media_ocr', nextStep: null };
      }
      let buffer;
      try {
        buffer = Buffer.from(base64, 'base64');
      } catch {
        return { status: 'failed', retryable: false, reason: 'screenshot_not_base64', provider: 'windows_media_ocr', nextStep: null };
      }
      if (!buffer.length) {
        return { status: 'failed', retryable: false, reason: 'screenshot_empty', provider: 'windows_media_ocr', nextStep: null };
      }
      if (buffer.length > MAX_IMAGE_BYTES) {
        return { status: 'failed', retryable: false, reason: 'screenshot_too_large', provider: 'windows_media_ocr', imageBytes: buffer.length, nextStep: null };
      }
      const dimensions = pngDimensions(buffer);
      if (!dimensions) {
        return { status: 'failed', retryable: false, reason: 'invalid_png', provider: 'windows_media_ocr', nextStep: null };
      }
      if (!tempDir) {
        return { status: 'failed', retryable: false, reason: 'ocr_temp_dir_unconfigured', provider: 'windows_media_ocr', nextStep: null };
      }

      cleanupStale();
      try { mkdirSync(tempDir, { recursive: true, mode: 0o700 }); } catch (error) {
        return { status: 'failed', retryable: false, reason: 'ocr_temp_dir_unwritable', provider: 'windows_media_ocr', detail: briefMessage(error?.message), nextStep: null };
      }
      const imagePath = join(tempDir, `ocr-${process.pid}-${randomUUID()}.png`);
      // The returned object and the finally block share this reference, so a
      // failed unlink is visible without being able to rewrite the verdict.
      const cleanup = { tempFileRemoved: null };
      const ret = value => ({ ...value, cleanup });
      try {
        await writeFile(imagePath, buffer, { mode: 0o600 });
        const outcome = await runner({ scriptPath, powershellPath, imagePath, language: requestedLanguage, timeoutMs });
        if (outcome?.timedOut) {
          return ret({ status: 'timeout', retryable: true, reason: 'ocr_timeout', provider: 'windows_media_ocr', timeoutMs, elapsedMs: Date.now() - startedAt, nextStep: null });
        }
        if (outcome?.error) {
          return ret({ status: 'failed', retryable: true, reason: 'ocr_process_error', provider: 'windows_media_ocr', detail: briefMessage(outcome.error, imagePath), nextStep: null });
        }
        const parsed = lastJsonLine(outcome?.stdout);
        if (!parsed) {
          return ret({
            status: 'failed', retryable: false, reason: 'ocr_output_unparseable', provider: 'windows_media_ocr',
            exitCode: Number.isInteger(outcome?.code) ? outcome.code : null,
            stderrPresent: Boolean(outcome?.stderr?.trim()),
            nextStep: null
          });
        }
        const availableLanguages = languageList(parsed.availableLanguages);
        if (parsed.error) {
          const common = {
            provider: 'windows_media_ocr',
            requestedLanguage: requestedLanguage || null,
            availableLanguages,
            nextStep: null
          };
          if (parsed.error === 'ocr_language_unavailable') {
            return ret({ status: 'unavailable', retryable: false, reason: 'ocr_language_unavailable', ...common });
          }
          if (parsed.error === 'ocr_engine_unavailable' || parsed.error === 'ocr_runtime_unavailable') {
            return ret({ status: 'unavailable', retryable: false, reason: parsed.error, ...common, detail: briefMessage(parsed.message, imagePath) });
          }
          if (parsed.error === 'image_too_large') {
            return ret({ status: 'failed', retryable: false, reason: 'image_too_large', ...common, image: dimensions, maxDimension: parsed.maxDimension ?? null });
          }
          return ret({ status: 'failed', retryable: false, reason: 'ocr_failed', ...common, detail: briefMessage(parsed.message, imagePath) });
        }
        if (!Number.isInteger(outcome?.code) || outcome.code !== 0) {
          return ret({ status: 'failed', retryable: false, reason: 'ocr_process_failed', provider: 'windows_media_ocr', exitCode: Number.isInteger(outcome?.code) ? outcome.code : null, nextStep: null });
        }
        if (parsed.width !== dimensions.width || parsed.height !== dimensions.height) {
          return ret({
            status: 'failed', retryable: false, reason: 'ocr_dimensions_mismatch', provider: 'windows_media_ocr',
            screenshot: dimensions, ocrImage: { width: parsed.width ?? null, height: parsed.height ?? null }, nextStep: null
          });
        }

        const rawLines = Array.isArray(parsed.lines) ? parsed.lines : [];
        const selected = rawLines.slice(0, resultLimit);
        let wordsTruncated = false;
        const normalized = [];
        for (const line of selected) {
          const rawText = String(line?.text ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim();
          const text = compactHanSpacing(rawText);
          const rect = pixelRect(line);
          if (!text || !rect) continue;
          let words;
          if (includeWords && Array.isArray(line.words)) {
            if (line.words.length > MAX_WORDS_PER_LINE) wordsTruncated = true;
            words = line.words.slice(0, MAX_WORDS_PER_LINE).map(word => ({
              text: String(word?.text ?? '').slice(0, 200),
              pixelRect: pixelRect(word)
            })).filter(word => word.text && word.pixelRect);
          }
          normalized.push({ text, pixelRect: rect, ...(words ? { words } : {}) });
        }
        const mapped = mapOcrLines({ lines: normalized, image: dimensions, viewport });
        const fullText = mapped.lines.map(line => line.text).join('\n');
        const textTruncated = fullText.length > MAX_TEXT_CHARS;
        const text = textTruncated ? fullText.slice(0, MAX_TEXT_CHARS) : fullText;

        return ret({
          status: 'success',
          ok: true,
          provider: 'windows_media_ocr',
          language: typeof parsed.language === 'string' ? parsed.language.slice(0, 40) : null,
          requestedLanguage: requestedLanguage || null,
          availableLanguages,
          image: { ...dimensions, mimeType: 'image/png' },
          lines: mapped.lines,
          coordinatesAvailable: mapped.coordinatesAvailable,
          scale: mapped.scale,
          lineCount: mapped.lines.length,
          text,
          textNormalization: 'Spaces between adjacent Han characters are removed; all other spacing is preserved.',
          empty: mapped.lines.length === 0,
          truncated: rawLines.length > selected.length || wordsTruncated || textTruncated,
          truncation: {
            lines: rawLines.length > selected.length,
            wordsPerLine: wordsTruncated,
            text: textTruncated
          },
          elapsedMs: Date.now() - startedAt,
          nextStep: null
        });
      } catch (error) {
        return ret({ status: 'failed', retryable: false, reason: 'ocr_adapter_error', provider: 'windows_media_ocr', detail: briefMessage(error?.message, imagePath), nextStep: null });
      } finally {
        cleanup.tempFileRemoved = await removeTempFile(imagePath);
      }
    }
  };
}
