// Read-only OCR coordination for one tab.
//
// The screenshot and the page state are child reads, so every policy decision
// is re-evaluated by call() and an agent denied browser_screenshot cannot reach
// OCR as a side door. This module never writes to the page and never stores the
// recognized text; the local ledger receives only run metadata.

const SCOPE = 'current viewport pixels only; text outside the viewport, unpainted text and text inside cross-origin iframes is absent';
const OCR_CONTENT_TRUST = 'untrusted webpage pixels; recognized text can be wrong, incomplete or adversarial';

function finitePositive(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function briefError(error) {
  const message = typeof error?.message === 'string' ? error.message : String(error ?? 'unknown');
  return message.slice(0, 300);
}

function pageBrief(page) {
  if (!page || typeof page !== 'object') return null;
  return {
    readyState: typeof page.readyState === 'string' ? page.readyState : null,
    visibilityState: typeof page.visibilityState === 'string' ? page.visibilityState : null,
    focused: typeof page.focused === 'boolean' ? page.focused : null,
    viewport: page.viewport && finitePositive(page.viewport.width) && finitePositive(page.viewport.height)
      ? { width: page.viewport.width, height: page.viewport.height }
      : null,
    scroll: Number.isFinite(page.scrollX) && Number.isFinite(page.scrollY)
      ? { x: page.scrollX, y: page.scrollY }
      : null
  };
}

function recommend(result) {
  if (result.status === 'success' && result.empty) {
    return 'OCR ran successfully and found no painted text. Inspect browser_screenshot, and for a canvas or WebGL app prefer the page data or app API through browser_eval over guessing a coordinate.';
  }
  if (result.status === 'success' && result.coordinatesAvailable) {
    return 'OCR is evidence, not an address: use browser_prepare_coordinate on one line.point to learn what is actually under that point, prefer its clickRef when it matches the intended control, and perform any write through browser_action_verified with a bounded expect. Never treat recognized text as proof of clickability.';
  }
  if (result.status === 'success') {
    return 'OCR succeeded, but the recognized text could not be mapped to the viewport. Re-read the page with browser_debug or browser_wait_until_ready and call browser_ocr again; do not convert pixel boxes by hand.';
  }
  if (result.status === 'partial') {
    return 'The page viewport was unavailable, so the text has no coordinates. Re-read with browser_debug or wait for layout and call browser_ocr again; do not convert pixel boxes by hand.';
  }
  if (result.reason === 'ocr_language_unavailable') {
    const available = Array.isArray(result.availableLanguages) && result.availableLanguages.length
      ? ` Available languages: ${result.availableLanguages.join(', ')}.`
      : ' No Windows OCR language pack is installed.';
    return `Nothing was recognized: the requested language has no OCR engine.${available} Retry once with a supported language tag, or use browser_screenshot plus coordinates.`;
  }
  if (result.status === 'unavailable') {
    return 'Windows OCR is not available on this host. Nothing was retried. Use browser_screenshot plus browser_prepare_coordinate, or browser_read / browser_eval when the text exists in the DOM. Ask the user to add a Windows OCR language pack only if pixel text is genuinely the only route.';
  }
  if (result.status === 'timeout') {
    return 'The local OCR process timed out; it has no side effect on the page. Retry once, then fall back to browser_screenshot and the DOM routes instead of repeating the same call.';
  }
  if (result.status === 'waiting') {
    return 'The screenshot needed for OCR is not ready yet. Preserve the task and poll with the reported nextPollTool; do not start another browser or change channels.';
  }
  if (result.status === 'denied') {
    return 'A read needed for OCR was denied by agent policy. Nothing was recognized. Adjust the allowed tool set, or use an allowed read route.';
  }
  if (result.status === 'blocked') {
    return 'The page blocks script injection, so the screenshot/read needed for OCR could not complete. Use browser_debug or browser_protected_ui_plan for the correct surface; do not retry the same read.';
  }
  return 'The local OCR route failed. This is not evidence that the page has no text. Check the host OCR runtime and Windows language packs, then retry once or fall back to browser_screenshot and the DOM routes.';
}

function recordRun(store, result, startedAt) {
  try {
    const recorded = store?.recordOcrRun({
      status: result.status,
      provider: result.provider ?? 'windows_media_ocr',
      language: result.language ?? result.requestedLanguage ?? null,
      lineCount: Number.isInteger(result.lineCount) ? result.lineCount : (Array.isArray(result.lines) ? result.lines.length : 0),
      imageWidth: Number.isFinite(result.image?.width) ? result.image.width : 0,
      imageHeight: Number.isFinite(result.image?.height) ? result.image.height : 0,
      truncated: result.truncated === true,
      durationMs: Date.now() - startedAt
    });
    return recorded === true;
  } catch {
    return false;
  }
}

export async function ocrTab({ args = {}, callTool, adapter, store = null } = {}) {
  const startedAt = Date.now();
  const tabId = args.tabId;
  const routing = {
    ...(typeof args.agent === 'string' && args.agent.trim() ? { agent: args.agent } : {}),
    ...(typeof args.hostId === 'string' ? { hostId: args.hostId } : {})
  };
  const base = { tabId, provider: 'windows_media_ocr', nextStep: null };

  let shot;
  try {
    shot = await callTool('browser_screenshot', { tabId, ...routing });
  } catch (error) {
    const result = {
      ...base, status: 'failed', ok: false, retryable: true, reason: 'screenshot_failed',
      detail: briefError(error), dispatched: false,
      message: 'The screenshot required by OCR threw before any recognition ran.'
    };
    result.recommendedNextAction = recommend(result);
    result.ledgerRecorded = recordRun(store, result, startedAt);
    return result;
  }
  if (!shot || typeof shot !== 'object' || Array.isArray(shot)) {
    const result = {
      ...base, status: 'failed', ok: false, retryable: false, reason: 'screenshot_invalid_result',
      dispatched: false, message: 'The screenshot tool returned an unusable result, so OCR did not run.'
    };
    result.recommendedNextAction = recommend(result);
    result.ledgerRecorded = recordRun(store, result, startedAt);
    return result;
  }
  if (typeof shot.status === 'string' && shot.status !== 'success') {
    const result = {
      ...base,
      status: shot.status,
      ok: false,
      retryable: shot.retryable === true,
      reason: typeof shot.reason === 'string' ? shot.reason : 'screenshot_failed',
      screenshotStatus: shot.status,
      dispatched: false,
      screenshotRecommendedNextAction: typeof shot.recommendedNextAction === 'string' ? shot.recommendedNextAction : null,
      message: 'The screenshot that OCR needs did not succeed, so no recognition ran.'
    };
    result.recommendedNextAction = recommend(result);
    result.ledgerRecorded = recordRun(store, result, startedAt);
    return result;
  }
  if (shot.error || typeof shot.data !== 'string' || !shot.data) {
    const result = {
      ...base, status: 'failed', ok: false, retryable: false,
      reason: shot.error ? 'screenshot_failed' : 'screenshot_missing',
      screenshotStatus: 'success', dispatched: false,
      detail: shot.error ? briefError(shot.error) : null,
      message: 'The screenshot result carried no PNG data, so no recognition ran.'
    };
    result.recommendedNextAction = recommend(result);
    result.ledgerRecorded = recordRun(store, result, startedAt);
    return result;
  }

  let page = null;
  try {
    const probe = await callTool('browser_debug', { tabId, ...routing });
    if (probe && typeof probe === 'object' && !Array.isArray(probe) && typeof probe.status !== 'string') page = probe;
  } catch { /* the screenshot still says the page exists; coordinates degrade honestly */ }
  const viewport = pageBrief(page)?.viewport ?? null;

  let recognition;
  try {
    recognition = await adapter.recognize({
      base64: shot.data,
      mimeType: typeof shot.mimeType === 'string' ? shot.mimeType : 'image/png',
      language: typeof args.language === 'string' ? args.language : '',
      maxLines: args.maxLines,
      includeWords: args.includeWords === true,
      viewport
    });
  } catch (error) {
    recognition = {
      status: 'failed', retryable: false, reason: 'ocr_adapter_error',
      provider: 'windows_media_ocr', detail: briefError(error), nextStep: null
    };
  }
  if (!recognition || typeof recognition !== 'object') {
    recognition = { status: 'failed', retryable: false, reason: 'ocr_adapter_error', provider: 'windows_media_ocr', nextStep: null };
  }
  if (typeof recognition.status !== 'string') {
    recognition = { ...recognition, status: 'failed', reason: recognition.reason ?? 'ocr_adapter_error' };
  }

  const coordinatesAvailable = recognition.status === 'success' && recognition.coordinatesAvailable === true;
  const result = {
    ...base,
    ...recognition,
    tabId,
    status: recognition.status === 'success' && !coordinatesAvailable ? 'partial' : recognition.status,
    ok: recognition.status === 'success' && coordinatesAvailable,
    screenshot: {
      mimeType: typeof shot.mimeType === 'string' ? shot.mimeType : 'image/png',
      sideEffects: Array.isArray(shot.sideEffects) ? shot.sideEffects : [],
      warmup: shot.warmup ?? null
    },
    page: pageBrief(page),
    viewport: viewport ? { ...viewport, source: 'browser_debug' } : null,
    coordinateSpace: coordinatesAvailable
      ? {
        css: 'CSS pixels relative to the visible viewport; scroll offsets are not included',
        normalized: '0..1000 viewport units accepted by browser_prepare_coordinate and browser_action',
        scale: recognition.scale ?? null
      }
      : {
        available: false,
        reason: 'viewport_unavailable',
        note: 'Pixel boxes are reported, but no CSS or 0..1000 point was computed because the page viewport could not be read.'
      },
    scope: SCOPE,
    noRefs: true,
    actionSafety: 'OCR returns text and coordinates only. It has no DOM ref, no role and no proof of clickability. Confirm the point with browser_prepare_coordinate and perform writes through browser_action_verified.',
    contentTrust: OCR_CONTENT_TRUST,
    ...(recognition.status === 'success' && !coordinatesAvailable ? { reason: 'viewport_unavailable' } : {}),
    ...(recognition.empty ? { empty: true } : {}),
    nextStep: null
  };
  result.recommendedNextAction = recommend(result);
  result.ledgerRecorded = recordRun(store, result, startedAt);
  return result;
}
