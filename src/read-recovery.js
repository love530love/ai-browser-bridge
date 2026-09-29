export async function recoverRead(name, operation, pause = ms => new Promise(resolve => setTimeout(resolve, ms))) {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      // No replay for writes, unknown failures, authorization or stale element errors.
      if (name !== 'browser_read' || attempt >= 6 || !/Navigation in progress|Page changed|Frame with ID 0 was removed/i.test(error.message)) throw error;
      await pause(250);
    }
  }
}
