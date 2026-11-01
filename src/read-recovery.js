// Reads only. browser_at is a read too, and it fails the same way for the same
// reason: it runs the same page read, so "Navigation in progress" reaches it
// unchanged. Leaving it out would make the small-shape read strictly less
// reliable than the large-shape one, which is the wrong way round.
const RETRYABLE_READS = new Set(['browser_read', 'browser_at']);

export async function recoverRead(name, operation, pause = ms => new Promise(resolve => setTimeout(resolve, ms))) {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      // No replay for writes, unknown failures, authorization or stale element errors.
      if (!RETRYABLE_READS.has(name) || attempt >= 6 || !/Navigation in progress|Page changed|Frame with ID 0 was removed/i.test(error.message)) throw error;
      await pause(250);
    }
  }
}
