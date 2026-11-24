// Character-captcha reading, coordinated on the service side.
//
// The page probe and the enlarged capture are child reads, so every policy
// decision is re-evaluated by call(): an agent denied the captcha read tools
// cannot reach OCR through this coordinator either. The recognized code is
// returned to the caller and never written to the local ledger - only run
// metadata (status, line count, image size, duration) is recorded.

const CONTENT_TRUST = 'untrusted webpage pixels; a distorted code can be misread, and a refreshed challenge looks identical in this metadata';
const EXPIRY = 'A graphical code expires quickly: type a candidate and continue the original flow immediately. If the site rejects it, refresh the challenge and read again instead of reusing this code.';

export const CHARSET_PATTERNS = {
  alnum: /[^A-Za-z0-9]/g,
  alpha: /[^A-Za-z]/g,
  digits: /[^0-9]/g
};

export function normalizeCaptchaText(text, charset = 'alnum') {
  const pattern = CHARSET_PATTERNS[charset] ?? CHARSET_PATTERNS.alnum;
  return String(text ?? '').replace(pattern, '');
}

// OCR lines become candidates, not an answer. A captcha code usually has a
// length the site advertises (maxLength or "4 characters"), so readings that
// match it are offered first; the raw joined reading stays last as evidence.
export function captchaCandidates({ lines = [], expectedLength = null, charset = 'alnum' } = {}) {
  const limit = Number.isInteger(expectedLength) && expectedLength >= 1 && expectedLength <= 12 ? expectedLength : null;
  const lineTexts = (Array.isArray(lines) ? lines : [])
    .map(line => normalizeCaptchaText(line?.text, charset))
    .filter(Boolean);
  const joined = normalizeCaptchaText(lineTexts.join(''), charset);
  const candidates = [];
  const add = (text, source) => {
    if (!text || candidates.some(item => item.text === text)) return;
    candidates.push({ text, length: text.length, source });
  };
  if (limit) {
    for (const text of lineTexts) if (text.length === limit) add(text, 'line');
    if (joined.length === limit) add(joined, 'joined');
    if (!candidates.length && joined.length > limit) {
      add(joined.slice(0, limit), 'prefix');
      add(joined.slice(-limit), 'suffix');
    }
  } else {
    add(joined, 'joined');
    if (lineTexts.length > 1) for (const text of lineTexts) add(text, 'line');
  }
  add(joined, 'joined');
  // lengthMatched answers "did OCR itself read the advertised number of
  // characters", not "does a truncation of a longer reading have that length":
  // prefix/suffix candidates are placeholders for a caller's eyes, and counting
  // them as a match would hide that the reading is the wrong size.
  const natural = candidates.some(item => item.length === limit && (item.source === 'line' || item.source === 'joined'));
  return {
    text: joined || null,
    candidates: candidates.slice(0, 6),
    lineCount: lineTexts.length,
    expectedLength: limit,
    charset,
    lengthMatched: limit ? natural : null
  };
}

function briefError(error) {
  const message = typeof error?.message === 'string' ? error.message : String(error ?? 'unknown');
  return message.slice(0, 300);
}

function unsupportedKindGuide(kind) {
  if (kind === 'grid') {
    return 'This is an image-grid challenge, not a character code. Capture it with browser_captcha_capture (the ref from browser_captcha_probe), choose tiles from the enlarged image, then answer with browser_captcha_click_verified and submit:true so the verdict is observed.';
  }
  if (kind === 'slider') {
    return 'This is a slider/jigsaw challenge. Use browser_slider_solve_verified; it refreshes, solves and judges the outcome in one verified call.';
  }
  if (kind === 'checkbox') {
    return 'This is a cross-origin checkbox widget whose state is not readable from the page. Click the widget ref with browser_click_verified to open the challenge, then probe again.';
  }
  return 'The challenge did not expose a readable code image plus input. Capture the challenge root with browser_captcha_capture and read the image visually; do not guess a code.';
}

function recommend(result) {
  if (result.status === 'success' && result.lengthMatched === false) {
    return `No OCR reading matches expectedLength ${result.expectedLength}; any prefix/suffix candidate is a truncation of a longer reading. Compare the attached image yourself and, if it is unreadable, call browser_captcha_refresh_verified and read again. ${EXPIRY}`;
  }
  if (result.status === 'success') {
    return `Type one candidate with browser_fill_verified (expect the input value to contain it), then continue the original flow. If the site rejects it, call browser_captcha_refresh_verified and read again rather than reusing this code. ${EXPIRY}`;
  }
  if (result.status === 'partial' && result.reason === 'no_characters_recognized') {
    return 'Local OCR ran but found no characters. An empty list is not proof the image is unreadable: read the attached enlarged image yourself. If it is genuinely unclear or expired, call browser_captcha_refresh_verified and read again. Nothing was typed.';
  }
  if (result.status === 'unavailable') {
    return 'Windows OCR is unavailable on this host, so nothing was recognized. The enlarged challenge image is attached: read it yourself, or use a vision-capable caller. Ask the user to add a Windows OCR language pack only if pixel reading is genuinely the only route.';
  }
  if (result.status === 'timeout') {
    return 'The local OCR process timed out; the page was not touched. Retry once, then read the enlarged image yourself instead of repeating the same call.';
  }
  if (result.status === 'not_found') {
    return 'No visible character challenge was found. An absent widget is not proof the page has none: trigger the action that opens it first, then probe again.';
  }
  if (result.status === 'unsupported') {
    return unsupportedKindGuide(result.kind);
  }
  if (result.status === 'stale') {
    return 'The challenge re-rendered or closed while it was being read. Probe again and read the fresh challenge; nothing was typed.';
  }
  if (result.status === 'waiting') {
    return 'A read needed for this capture is not ready yet. Preserve the task and poll with the reported nextPollTool; do not start another browser or change channels.';
  }
  if (result.status === 'denied') {
    return 'A read needed for this capture was denied by agent policy. Nothing was read or typed. Adjust the allowed tool set, or use an allowed read route.';
  }
  if (result.status === 'blocked') {
    return 'The page blocks script injection, so the probe/capture could not complete. Use browser_protected_ui_plan for the correct surface; do not retry the same read.';
  }
  return 'The character-captcha read failed before a code was produced. This is not evidence that the challenge is unreadable. Re-observe the page, then retry once or read the challenge visually.';
}

function recordRun(store, result, startedAt) {
  try {
    const recorded = store?.recordOcrRun({
      status: result.status,
      provider: result.ocr?.provider ?? 'windows_media_ocr',
      language: result.ocr?.language ?? result.ocr?.requestedLanguage ?? null,
      lineCount: Number.isInteger(result.ocr?.lineCount) ? result.ocr.lineCount : 0,
      imageWidth: Number.isFinite(result.imageWidth) ? result.imageWidth : 0,
      imageHeight: Number.isFinite(result.imageHeight) ? result.imageHeight : 0,
      truncated: false,
      durationMs: Date.now() - startedAt
    });
    return recorded === true;
  } catch {
    return false;
  }
}

export async function captchaReadCharacter({ args = {}, callTool, adapter, store = null } = {}) {
  const startedAt = Date.now();
  const tabId = args.tabId;
  const routing = {
    ...(typeof args.agent === 'string' && args.agent.trim() ? { agent: args.agent } : {}),
    ...(typeof args.hostId === 'string' ? { hostId: args.hostId } : {})
  };
  const base = {
    tabId, kind: 'character', provider: null, nextStep: null,
    contentTrust: CONTENT_TRUST, noRefs: false,
    actionSafety: 'This tool only reads. Typing the code and submitting it remain separate verified writes chosen by the caller.'
  };
  const finish = result => {
    result.recommendedNextAction = result.recommendedNextAction ?? recommend(result);
    result.ledgerRecorded = recordRun(store, result, startedAt);
    return result;
  };

  let probe;
  try {
    probe = await callTool('browser_captcha_probe', {
      tabId,
      ...(Number.isInteger(args.frame) ? { frame: args.frame } : {}),
      ...routing
    });
  } catch (error) {
    return finish({ ...base, status: 'failed', ok: false, retryable: true, reason: 'captcha_probe_failed',
      dispatched: false, detail: briefError(error),
      message: 'The probe threw before any challenge was read.' });
  }
  if (!probe || typeof probe !== 'object' || Array.isArray(probe)) {
    return finish({ ...base, status: 'failed', ok: false, retryable: false, reason: 'captcha_probe_invalid_result',
      dispatched: false, message: 'The probe returned an unusable result, so nothing was captured.' });
  }
  if (typeof probe.status === 'string' && probe.status !== 'success') {
    return finish({ ...base, status: probe.status, ok: false, retryable: probe.retryable === true,
      reason: probe.reason ?? 'captcha_probe_failed', probeStatus: probe.status, dispatched: false,
      ...(probe.nextPollTool ? { nextPollTool: probe.nextPollTool } : {}),
      ...(probe.recommendedNextAction ? { recommendedNextAction: probe.recommendedNextAction } : {}),
      message: 'The probe did not succeed, so nothing was captured.' });
  }
  const challenge = probe.challenge ?? null;
  if (probe.found !== true || !challenge) {
    return finish({ ...base, status: 'not_found', ok: false, retryable: false, found: false,
      reason: 'challenge_not_found', frames: probe.frames ?? [], dispatched: false,
      message: 'No visible verification challenge matched in any accessible frame.' });
  }
  if (challenge.kind !== 'character') {
    return finish({ ...base, status: 'unsupported', ok: false, retryable: false, found: true,
      kind: challenge.kind ?? 'unknown', provider: challenge.provider ?? null,
      reason: 'challenge_kind_not_character', frameId: probe.frameId ?? 0,
      challenge: { ref: challenge.ref ?? null, token: challenge.token ?? null, instruction: challenge.instruction ?? null },
      dispatched: false,
      message: 'This challenge is not a character code; a character read would guess the wrong thing.' });
  }

  const frameId = Number.isInteger(probe.frameId) ? probe.frameId : (Number.isInteger(args.frame) ? args.frame : 0);
  const image = challenge.image ?? null;
  const imageTarget = image?.ref
    ? { ref: image.ref }
    : (image?.selector && frameId === 0 ? { selector: image.selector } : null);
  if (!imageTarget) {
    return finish({ ...base, status: 'failed', ok: false, retryable: false, found: true,
      provider: challenge.provider ?? null, reason: 'code_image_not_addressable', frameId,
      challenge: { ref: challenge.ref ?? null, token: challenge.token ?? null, input: challenge.input ?? null },
      dispatched: false,
      message: 'The challenge has a code input, but its image could not be addressed for capture. Capture the challenge root with browser_captcha_capture and read the image visually.' });
  }

  let capture;
  try {
    capture = await callTool('browser_captcha_capture', {
      tabId, ...imageTarget, frame: frameId,
      scale: Number.isInteger(args.scale) ? args.scale : 6,
      padding: Number.isInteger(args.padding) ? args.padding : 8,
      ...routing
    });
  } catch (error) {
    return finish({ ...base, status: 'failed', ok: false, retryable: true, found: true,
      provider: challenge.provider ?? null, reason: 'captcha_capture_failed', frameId,
      dispatched: false, detail: briefError(error),
      message: 'The capture threw before any recognition ran.' });
  }
  if (!capture || typeof capture !== 'object' || Array.isArray(capture) || typeof capture.data !== 'string' || !capture.data) {
    const status = typeof capture?.status === 'string' && capture.status !== 'success' ? capture.status : 'failed';
    return finish({ ...base, status, ok: false, retryable: capture?.retryable === true, found: true,
      provider: challenge.provider ?? null, reason: capture?.reason ?? 'captcha_capture_missing_data', frameId,
      dispatched: false,
      ...(capture?.recommendedNextAction ? { recommendedNextAction: capture.recommendedNextAction } : {}),
      message: 'The capture that OCR needs did not produce an image, so nothing was recognized.' });
  }
  const imageBlock = {
    data: capture.data,
    mimeType: typeof capture.mimeType === 'string' ? capture.mimeType : 'image/png',
    rect: capture.rect ?? null,
    clip: capture.clip ?? null,
    scale: capture.scale ?? null,
    padding: capture.padding ?? null,
    target: capture.target ?? null
  };
  const challengeBlock = {
    ref: challenge.ref ?? null,
    token: challenge.token ?? null,
    instruction: challenge.instruction ?? null,
    error: challenge.error ?? null,
    image: image ? { ref: image.ref ?? null, selector: image.selector ?? null, rect: image.rect ?? null, source: image.source ?? null } : null,
    input: challenge.input ?? null,
    refresh: challenge.refresh ? { ref: challenge.refresh.ref ?? null, text: challenge.refresh.text ?? null } : null,
    // A code expires quickly; without the submit ref the caller must spend a
    // second probe before it can answer.
    submit: challenge.submit ? { ref: challenge.submit.ref ?? null, text: challenge.submit.text ?? null } : null
  };
  const shared = {
    ...base,
    found: true,
    provider: challenge.provider ?? null,
    frameId,
    challenge: challengeBlock,
    image: imageBlock,
    capture: {
      coordinateSpace: capture.coordinateSpace ?? null,
      sideEffects: Array.isArray(capture.sideEffects) ? capture.sideEffects : [],
      warmup: capture.warmup ?? null
    },
    scope: frameId === 0
      ? 'the code image element (plus padding), captured at scale from the top document'
      : 'the host iframe box in the top document; the code image sits inside that frame',
    expires: EXPIRY
  };

  let recognition;
  try {
    recognition = await adapter.recognize({
      base64: capture.data,
      mimeType: imageBlock.mimeType,
      language: typeof args.language === 'string' ? args.language : '',
      maxLines: 8,
      includeWords: false,
      viewport: null
    });
  } catch (error) {
    recognition = { status: 'failed', retryable: false, reason: 'ocr_adapter_error', detail: briefError(error) };
  }
  if (!recognition || typeof recognition !== 'object') {
    recognition = { status: 'failed', retryable: false, reason: 'ocr_adapter_error' };
  }
  const ocr = {
    provider: recognition.provider ?? 'windows_media_ocr',
    language: recognition.language ?? null,
    requestedLanguage: recognition.requestedLanguage ?? (typeof args.language === 'string' && args.language ? args.language : null),
    lineCount: Array.isArray(recognition.lines) ? recognition.lines.length : 0,
    empty: recognition.empty === true,
    truncated: recognition.truncated === true,
    elapsedMs: Number.isFinite(recognition.elapsedMs) ? recognition.elapsedMs : null
  };
  const dimensions = recognition.image ?? null;
  const withDimensions = result => ({
    ...shared, ...result, ocr,
    ...(dimensions ? { imageWidth: dimensions.width, imageHeight: dimensions.height } : {})
  });

  if (recognition.status === 'unavailable' || recognition.status === 'timeout') {
    return finish(withDimensions({
      status: recognition.status,
      ok: false,
      retryable: recognition.retryable === true,
      reason: recognition.reason ?? 'ocr_unavailable',
      availableLanguages: Array.isArray(recognition.availableLanguages) ? recognition.availableLanguages : undefined,
      message: 'Local OCR did not run, so no candidate was produced. The enlarged image is attached for visual reading.'
    }));
  }
  if (recognition.status !== 'success') {
    return finish(withDimensions({
      status: 'failed', ok: false, retryable: recognition.retryable === true,
      reason: recognition.reason ?? 'ocr_failed',
      message: 'Local OCR failed, so no candidate was produced. The enlarged image is attached for visual reading.'
    }));
  }

  const normalized = captchaCandidates({
    lines: recognition.lines ?? [],
    expectedLength: args.expectedLength,
    charset: typeof args.charset === 'string' ? args.charset : 'alnum'
  });
  const empty = normalized.candidates.length === 0;
  return finish(withDimensions({
    status: empty ? 'partial' : 'success',
    ok: !empty,
    retryable: empty,
    found: true,
    ...(empty ? { reason: 'no_characters_recognized', partial: true } : {}),
    text: normalized.text,
    candidates: normalized.candidates,
    expectedLength: normalized.expectedLength,
    charset: normalized.charset,
    lengthMatched: normalized.lengthMatched,
    candidateCount: normalized.candidates.length,
    normalization: 'Non-charset characters and whitespace are removed; case is preserved because the site may compare exactly. A rejected answer is refresh-and-read again, never a case-only retry.',
    message: empty
      ? 'The capture succeeded, but OCR recognized no characters in the requested charset.'
      : 'Candidate codes were read from the enlarged challenge image. They are evidence, not a verified answer: the site still judges what is typed.'
  }));
}
