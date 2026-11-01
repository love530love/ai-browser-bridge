export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// browser_at reads the page through the same operation as browser_read, so it
// times out the same way and deserves the same degrade step. It is a separate
// branch rather than the same argument set because its schema is deliberately
// narrower: sending maxTextNodes or budgetMs to it is an unknown-argument
// rejection, and a recovery step that gets rejected is worse than none.
const DEGRADABLE_READS = new Set(['browser_read', 'browser_at']);

export function nextReadArgs(name, args, result) {
  if (!DEGRADABLE_READS.has(name) || result?.reason !== 'read_timeout') return args;
  if (args.mode === 'cheap') return args;
  const next = {
    ...args,
    mode: 'cheap',
    maxChars: Math.min(args.maxChars ?? 6000, 6000),
    maxElements: Math.min(args.maxElements ?? 120, 120)
  };
  if (name === 'browser_read') {
    next.maxTextNodes = Math.min(args.maxTextNodes ?? 1000, 1000);
    next.budgetMs = Math.min(args.budgetMs ?? 1500, 1500);
  }
  return next;
}

export async function callWithWaitingRecovery({ name, args = {}, rawCall, maxWaitMs = 120000, pause = sleep }) {
  const started = Date.now();
  let attempts = 0;
  let currentArgs = { ...args };
  const events = [];
  while (true) {
    const response = await rawCall(name, currentArgs);
    const result = response?.result ?? response;
    if (!result || result.status !== 'waiting' || result.retryable !== true) {
      if (events.length && response?.result) response.result.autoRecovery = { attempts, elapsedMs: Date.now() - started, events };
      return response;
    }
    attempts++;
    events.push({ reason: result.reason || 'waiting', tool: result.tool || name, elapsedMs: Date.now() - started });
    if (Date.now() - started >= maxWaitMs) {
      if (response?.result) response.result.autoRecovery = { attempts, elapsedMs: Date.now() - started, exhausted: true, events };
      return response;
    }
    if (result.nextPollTool) {
      const pollArgs = result.nextPollArgs || { timeoutMs: Math.min(30000, Math.max(1000, result.suggestedDelayMs ?? 1000)), idle: true };
      const poll = await rawCall(result.nextPollTool, pollArgs);
      const pollResult = poll?.result ?? poll;
      events.push({ reason: pollResult?.status === 'ready' ? 'ready' : (pollResult?.reason || 'poll'), tool: result.nextPollTool, elapsedMs: Date.now() - started });
    } else {
      await pause(Math.min(5000, Math.max(100, result.suggestedDelayMs ?? 1000)));
    }
    currentArgs = nextReadArgs(name, currentArgs, result);
  }
}
