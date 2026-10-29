// Native messaging.
//
// This is the one tool that leaves the browser sandbox, so it is the one tool
// where "the browser said no" and "the host said no" are completely different
// problems and a caller has to be able to tell them apart:
//
//   native_host_not_registered - Chrome has no host under that name for this
//       extension id. Nothing ran. The fix is an install, not a retry.
//   native_host_no_reply       - the host was launched and never answered. It
//       may have crashed, or it may still be working. The outcome is unknown.
//   native_host_closed         - the port closed before a reply arrived, which
//       is what a host that exits non-zero looks like from here.
//
// Ports are kept open only when the caller asks, because a port holds a live
// process: a bridge that silently accumulated them would leave orphaned node
// processes behind every call. The map is bounded for the same reason.
const MAX_PORTS = 8;
const DEFAULT_TIMEOUT_MS = 20000;
const MAX_TIMEOUT_MS = 120000;
const MAX_MESSAGE_BYTES = 1024 * 1024;

function text(value, max = 400) {
  return typeof value === 'string' ? value.slice(0, max) : null;
}

export function createNativeMessaging() {
  // portId -> { port, host, openedAt, lastReplyAt }
  const ports = new Map();
  let counter = 0;

  function describe(portId) {
    const record = ports.get(portId);
    if (!record) return null;
    return { portId, host: record.host, openedAt: record.openedAt, lastReplyAt: record.lastReplyAt };
  }

  function close(portId) {
    const record = ports.get(portId);
    if (!record) return false;
    ports.delete(portId);
    try { record.port.disconnect(); } catch { /* already gone */ }
    return true;
  }

  function evictOldest() {
    while (ports.size >= MAX_PORTS) {
      const oldest = ports.keys().next().value;
      if (oldest === undefined) break;
      close(oldest);
    }
  }

  async function send(args) {
    const host = String(args.host ?? '');
    if (!host || host.length > 200) {
      return { status: 'denied', retryable: false, reason: 'host_required', message: 'Pass the native host name exactly as it is registered, for example "com.aibridge.host".' };
    }
    const message = args.message ?? null;
    if (message === null || typeof message !== 'object' || Array.isArray(message)) {
      return { status: 'denied', retryable: false, reason: 'message_required', message: 'Pass message as a JSON object. A native host receives exactly one object per frame.' };
    }
    const keepOpen = args.keepOpen === true;
    const outcome = await invoke(host, message, args.timeoutMs);
    if (!outcome.ok) return outcome.result;
    if (keepOpen) {
      ports.set(outcome.portId, { port: outcome.port, host, openedAt: new Date().toISOString(), lastReplyAt: new Date().toISOString() });
      return { ...outcome.result, portKeptOpen: true, openPorts: [...ports.keys()] };
    }
    try { outcome.port.disconnect(); } catch { /* the port may already be closed */ }
    return { ...outcome.result, portKeptOpen: false };
  }

  // The transport, separated from the tool so another tool can use the same
  // channel without going through the generic send gate. That is not a
  // loophole: the caller here is a tool with its own confirmation string and a
  // fixed command, so there is nothing for a generic gate to classify.
  async function invoke(host, message, requestedTimeout) {
    if (!host || host.length > 200) {
      return { ok: false, result: { status: 'denied', retryable: false, reason: 'host_required', message: 'Pass the native host name exactly as it is registered, for example "com.aibridge.host".' } };
    }
    if (typeof chrome.runtime?.connectNative !== 'function') {
      return { ok: false, result: { status: 'unavailable', retryable: false, reason: 'native_messaging_unavailable', message: 'This Chrome build exposes no chrome.runtime.connectNative.' } };
    }
    if (message === null || typeof message !== 'object' || Array.isArray(message)) {
      return { ok: false, result: { status: 'denied', retryable: false, reason: 'message_required', message: 'Pass message as a JSON object. A native host receives exactly one object per frame.' } };
    }
    // A service worker has no Buffer, so the size is measured with TextEncoder.
    // Using Buffer.byteLength here threw, the catch treated the unknown size as
    // enormous, and every send was refused as message_too_large - which is
    // exactly the kind of "the permission exists but the tool cannot work" bug
    // that only a real call finds.
    let bytes = 0;
    try {
      const encoded = JSON.stringify(message);
      bytes = typeof TextEncoder === 'function' ? new TextEncoder().encode(encoded).length : encoded.length;
    } catch {
      return { ok: false, result: { status: 'denied', retryable: false, reason: 'message_not_serialisable', message: 'message could not be serialised to JSON, so nothing was sent.' } };
    }
    if (bytes > MAX_MESSAGE_BYTES) {
      return { ok: false, result: { status: 'denied', retryable: false, reason: 'message_too_large', message: `Native messages are capped at ${MAX_MESSAGE_BYTES} bytes; nothing was sent.`, bytes } };
    }
    const requested = Number(requestedTimeout);
    const timeoutMs = Number.isFinite(requested) ? Math.min(MAX_TIMEOUT_MS, Math.max(500, Math.trunc(requested))) : DEFAULT_TIMEOUT_MS;

    evictOldest();
    let port;
    try {
      port = chrome.runtime.connectNative(host);
    } catch (error) {
      return {
        ok: false,
        result: {
          status: 'denied', retryable: false, reason: 'native_host_not_registered', host,
          message: 'Chrome refused to launch the host, which almost always means no host is registered under that name for this extension id. Install it with browser_native_host action:"install", then retry.',
          detail: String(error?.message ?? error)
        }
      };
    }

    const portId = `native-${++counter}`;
    const result = await new Promise(resolve => {
      let settled = false;
      const finish = value => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => {
        finish({
          status: 'uncertain', retryable: false, reason: 'native_host_no_reply', host, portId,
          message: 'The host was launched and accepted the message but never answered in time, so the outcome is unknown. Do not send the same message again until you know whether the first one took effect.',
          timeoutMs
        });
      }, timeoutMs);
      port.onMessage.addListener(reply => {
        const record = ports.get(portId);
        if (record) record.lastReplyAt = new Date().toISOString();
        finish({ status: 'success', retryable: false, host, portId, reply });
      });
      port.onDisconnect.addListener(() => {
        // chrome.runtime.lastError is only readable inside this callback, and it
        // carries the difference between "never registered" and "crashed".
        const raw = chrome.runtime.lastError?.message ?? '';
        const gone = /not found|not registered|host.*missing/i.test(raw);
        finish({
          status: gone ? 'denied' : 'failed',
          retryable: false,
          reason: gone ? 'native_host_not_registered' : 'native_host_closed',
          host, portId,
          message: gone
            ? 'Chrome found no native host under that name for this extension id, so nothing ran. Install it with browser_native_host action:"install", then retry.'
            : 'The native host closed the port before replying. It most likely exited, which for this host means the operation itself failed; the host log records it.',
          detail: raw || null
        });
      });
      try {
        port.postMessage(message);
      } catch (error) {
        finish({ status: 'failed', retryable: false, reason: 'native_message_post_failed', host, portId, message: String(error?.message ?? error) });
      }
    });

    const ok = result.status === 'success';
    return { ok, result, port, portId };
  }

  async function closePort(args) {
    const portId = String(args.portId ?? '');
    const closed = close(portId);
    return {
      status: closed ? 'success' : 'denied',
      retryable: false,
      action: 'close',
      portId,
      closed,
      openPorts: [...ports.keys()],
      message: closed ? 'The port was disconnected, which ends the host process.' : 'No open port with that id. Nothing was closed.'
    };
  }

  async function list() {
    return {
      status: 'success', retryable: false, action: 'list',
      openPorts: [...ports.values()].map(record => ({ host: record.host, openedAt: record.openedAt, lastReplyAt: record.lastReplyAt, portId: [...ports.entries()].find(([, value]) => value === record)?.[0] ?? null })),
      count: ports.size,
      note: 'A port holds a live host process. Close ports you are done with; the bridge also evicts the oldest once eight are open.'
    };
  }

  const HANDLERS = { send, close: closePort, list };
  return {
    names: new Set(['browser_native_messaging', 'browser_native_ports']),
    // Exposed so a tool with its own confirmation string can reuse the channel
    // for one fixed command without going through the generic send gate.
    invoke,
    async run(name, args = {}) {
      if (name !== 'browser_native_messaging' && name !== 'browser_native_ports') return null;
      // Sending is gated upstream by its own confirmation string; listing and
      // closing ports is not, because a port is a handle on a process that a
      // gated call already started, not a new capability.
      const action = name === 'browser_native_ports' ? (args.action ?? 'list') : 'send';
      const handler = HANDLERS[action];
      if (!handler || (name === 'browser_native_ports' && action === 'send')) {
        return {
          status: 'denied', retryable: false, reason: 'unknown_action', tool: name,
          message: name === 'browser_native_ports'
            ? `Unknown action "${String(action)}"; use list or close. Sending needs browser_native_messaging, which carries its own confirmation.`
            : `Unknown action "${String(action)}"; use send.`
        };
      }
      try {
        return await handler(args);
      } catch (error) {
        return { status: 'failed', retryable: false, reason: 'native_messaging_failed', tool: name, message: String(error?.message ?? error) };
      }
    }
  };
}

export const NATIVE_MESSAGING_LIMITS = { MAX_PORTS, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, MAX_MESSAGE_BYTES };
