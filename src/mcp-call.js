// MCP clients own their task lifetime. Do not hide a two-minute polling loop
// inside a tool request that clients may cancel after one minute.
export async function mcpToolCall(name, args, rawCall) {
  const effectiveArgs = name === 'browser_wait_until_ready'
    ? { ...args, timeoutMs: Math.min(args.timeoutMs ?? 20000, 20000) }
    : args;
  const response = await rawCall(name, effectiveArgs);
  const result = response?.result ?? response;
  if (name === 'browser_screenshot' && typeof result?.data === 'string' && !result.status) {
    return { content: [{ type: 'image', data: result.data, mimeType: 'image/png' }] };
  }
  return { content: [{ type: 'text', text: JSON.stringify(result) }] };
}
