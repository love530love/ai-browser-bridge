// Bounded, persisted outbox. Never store raw page errors, URLs, credentials or inputs.
export function createErrorJournal(storage, send, { limit = 100, now = () => new Date().toISOString(), id = () => crypto.randomUUID() } = {}) {
  const key = 'errorOutboxV1';
  let chain = Promise.resolve();
  const serial = fn => {
    const next = chain.then(fn);
    chain = next.catch(() => {});
    return next;
  };
  const read = async () => (await storage.get({ [key]: { records: [], dropped: 0 } }))[key];
  return {
    record: (source, category) => serial(async () => {
      const state = await read();
      state.records.push({ eventId: id(), at: now(), source: String(source).replace(/[^a-zA-Z0-9_:-]/g, '').slice(0, 80), category: String(category).replace(/[^A-Z_]/g, '').slice(0, 80), message: 'Extension diagnostic event; raw error omitted to protect page data.' });
      while (state.records.length > limit) { state.records.shift(); state.dropped++; }
      await storage.set({ [key]: state });
    }),
    flush: () => serial(async () => {
      const state = await read();
      for (const record of state.records) if (!send({ type: 'extension-error', ...record, droppedBeforeSend: state.dropped })) break;
    }),
    acknowledge: eventId => serial(async () => {
      const state = await read();
      state.records = state.records.filter(row => row.eventId !== eventId);
      await storage.set({ [key]: state });
    })
  };
}
