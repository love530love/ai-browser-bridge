// One-off, read-only evidence for the CDP gateway gates. This is not a gateway:
// it records which commands the extension debugger channel actually answers, and
// never exposes a browser-level WebSocket.

const MAX_TARGETS = 200;
const MAX_FRAMES = 200;
const MAX_ERROR_CHARS = 300;

function clamp(value, limit) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

export function redactUrl(value) {
  try {
    const url = new URL(String(value));
    if (url.protocol === 'http:' || url.protocol === 'https:') return `${url.protocol}//${url.host}/`;
    return `${url.protocol}//`;
  } catch {
    return '<unparseable>';
  }
}

function countByType(items, read) {
  const counts = {};
  for (const item of items) {
    const type = clamp(read(item) ?? 'unknown', 40);
    counts[type] = (counts[type] ?? 0) + 1;
  }
  return counts;
}

function classifyError(error) {
  const message = clamp(error?.message ?? error, MAX_ERROR_CHARS);
  const explicit = Number.isInteger(error?.code) ? error.code : null;
  const notFound = /-32601|wasn't found|is not supported|not supported by this channel/i.test(message);
  return {
    ok: false,
    code: explicit ?? (notFound ? -32601 : null),
    classification: explicit === -32601 || notFound ? 'unsupported' : 'refused',
    message
  };
}

async function probeCommand(send, method, params, summarize) {
  const startedAt = Date.now();
  try {
    const value = await send(method, params);
    let summary;
    try { summary = summarize(value); } catch (error) { summary = { summarizeError: clamp(error?.message ?? error, MAX_ERROR_CHARS) }; }
    return { method, ok: true, ms: Date.now() - startedAt, summary };
  } catch (error) {
    return { method, ...classifyError(error), ms: Date.now() - startedAt };
  }
}

function frameCount(frameTree, budget) {
  if (!frameTree?.frame || budget.count >= MAX_FRAMES) return budget;
  budget.count += 1;
  for (const child of Array.isArray(frameTree.childFrames) ? frameTree.childFrames : []) {
    frameCount(child, budget);
    if (budget.count >= MAX_FRAMES) break;
  }
  return budget;
}

export function summarizeTargets(targetInfos) {
  const targets = Array.isArray(targetInfos) ? targetInfos.slice(0, MAX_TARGETS) : [];
  const byType = countByType(targets, target => target?.type);
  return {
    count: targets.length,
    truncated: Array.isArray(targetInfos) && targetInfos.length > MAX_TARGETS,
    byType,
    pageCount: byType.page ?? 0,
    browserCount: byType.browser ?? 0,
    attachedCount: targets.filter(target => target?.attached === true).length,
    browserContextIdPresent: targets.some(target => typeof target?.browserContextId === 'string' && target.browserContextId.length > 0)
  };
}

export function summarizeExtensionTargets(targets) {
  const items = Array.isArray(targets) ? targets.slice(0, MAX_TARGETS) : [];
  const byType = countByType(items, target => target?.type);
  return {
    count: items.length,
    truncated: Array.isArray(targets) && targets.length > MAX_TARGETS,
    byType,
    attachedCount: items.filter(target => target?.attached === true).length
  };
}

export async function runCdpProbe({ tab, send, getTargets, channel, now = Date.now, userAgent = '' } = {}) {
  const capturedAt = new Date(now()).toISOString();
  let extensionApi;
  if (typeof getTargets === 'function') {
    try {
      extensionApi = { ok: true, summary: summarizeExtensionTargets(await getTargets()) };
    } catch (error) {
      extensionApi = classifyError(error);
    }
  } else {
    extensionApi = { ok: false, classification: 'unavailable', message: 'chrome.debugger.getTargets is not callable here' };
  }

  const commands = [];
  commands.push(await probeCommand(send, 'Target.getTargets', {}, value => summarizeTargets(value?.targetInfos)));
  const domainNames = new Set();
  commands.push(await probeCommand(send, 'Schema.getDomains', {}, value => {
    for (const domain of Array.isArray(value?.domains) ? value.domains : []) {
      if (domain?.name) domainNames.add(domain.name);
    }
    return {
      domainCount: domainNames.size,
      hasTarget: domainNames.has('Target'),
      hasPage: domainNames.has('Page'),
      hasRuntime: domainNames.has('Runtime'),
      hasInput: domainNames.has('Input'),
      hasNetwork: domainNames.has('Network'),
      hasDOM: domainNames.has('DOM'),
      hasCSS: domainNames.has('CSS'),
      hasOverlay: domainNames.has('Overlay'),
      hasServiceWorker: domainNames.has('ServiceWorker'),
      hasFetch: domainNames.has('Fetch'),
      hasWebAuthn: domainNames.has('WebAuthn'),
      hasTracing: domainNames.has('Tracing'),
      hasHeapProfiler: domainNames.has('HeapProfiler'),
      hasAudits: domainNames.has('Audits'),
      hasExtensions: domainNames.has('Extensions'),
      hasLog: domainNames.has('Log'),
      hasAccessibility: domainNames.has('Accessibility'),
      hasPerformance: domainNames.has('Performance')
    };
  }));
  commands.push(await probeCommand(send, 'Page.getFrameTree', {}, value => ({
    frameCount: frameCount(value?.frameTree, { count: 0 }).count,
    topFrameUrl: redactUrl(value?.frameTree?.frame?.url ?? '')
  })));
  commands.push(await probeCommand(send, 'Runtime.evaluate', {
    expression: '1+1', returnByValue: true, awaitPromise: false, timeout: 1000
  }, value => ({
    returnedTwo: value?.result?.value === 2,
    resultType: typeof value?.result?.value,
    exception: Boolean(value?.exceptionDetails)
  })));
  commands.push(await probeCommand(send, 'Input.setIgnoreInputEvents', { ignore: false }, () => ({ accepted: true, changedDefault: false })));
  commands.push(await probeCommand(send, 'Network.getCookies', { urls: ['https://example.invalid/'] }, value => ({
    cookieCount: Array.isArray(value?.cookies) ? value.cookies.length : null
  })));
  // Read-only installability evidence for the PWA route. The manifest body is
  // summarised rather than returned: it is page-controlled text and the probe is
  // not a content reader.
  commands.push(await probeCommand(send, 'Page.getInstallabilityErrors', {}, value => ({
    errorCount: Array.isArray(value?.installabilityErrors) ? value.installabilityErrors.length : null,
    errorIds: Array.isArray(value?.installabilityErrors)
      ? value.installabilityErrors.map(item => clamp(item?.errorId ?? item?.error ?? 'unknown', 80)).slice(0, 20)
      : []
  })));
  commands.push(await probeCommand(send, 'Page.getAppManifest', {}, value => ({
    manifestUrl: value?.url ? redactUrl(value.url) : null,
    dataChars: typeof value?.data === 'string' ? value.data.length : null,
    parseErrorCount: Array.isArray(value?.errors) ? value.errors.length : null
  })));

  const byMethod = Object.fromEntries(commands.map(command => [command.method, command]));
  const unsupported = commands.filter(command => command.classification === 'unsupported').map(command => command.method);
  const refused = commands.filter(command => command.classification === 'refused').map(command => ({ method: command.method, code: command.code, message: command.message }));
  const accepted = commands.filter(command => command.ok).map(command => command.method);
  const targetCommand = byMethod['Target.getTargets'];
  const gate1 = targetCommand?.ok
    ? 'target_domain_available'
    : targetCommand?.classification === 'unsupported' ? 'target_domain_unavailable' : 'inconclusive';

  return {
    status: 'success',
    readOnly: true,
    channel,
    capturedAt,
    tab: { tabId: tab?.id ?? null, url: redactUrl(tab?.url ?? ''), active: Boolean(tab?.active) },
    chrome: { userAgent: clamp(userAgent, 200), debuggerProtocol: '1.3' },
    extensionApi,
    commands,
    verdict: {
      gate1,
      gate2: { accepted, unsupported, refused },
      targetDomain: targetCommand?.ok ? 'answers_in_page_session' : targetCommand?.classification === 'unsupported' ? 'not_exposed_in_page_session' : 'unknown',
      // Schema.getDomains reports what the page-level debugger channel will
      // answer, not what this bridge has implemented. A domain listed here is
      // reachable; a command inside it can still be refused.
      domainAvailability: Object.fromEntries([...domainNames].sort().map(name => [name, true])),
      browserLevelEndpoint: false,
      note: 'A page-level debugger session answering Target.* is not a browser-level CDP endpoint. connect_over_cdp also needs browser WebSocket discovery and Target.attachToTarget(flatten), which this probe does not test.'
    },
    sideEffects: [
      'Runtime.evaluate ran "1+1" in the page global',
      'Network.getCookies queried only https://example.invalid/ and returned values were discarded',
      'Input.setIgnoreInputEvents was set to its default false',
      channel === 'one_off_attach' ? 'The debugger was attached and detached for this probe; a banner and DevTools lock existed only during the probe' : 'An existing debugger session was reused; nothing was attached or detached'
    ]
  };
}
