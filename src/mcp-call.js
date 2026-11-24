// MCP clients own their task lifetime. Do not hide a two-minute polling loop
// inside a tool request that clients may cancel after one minute.
//
// Some reads are pictures: a screenshot, an element capture, a captcha capture
// and a character-captcha read. They return an image content block so the
// caller can actually look at the pixels, and the remaining metadata as a text
// block without the base64 payload. Everything else stays a single JSON text
// block.
const IMAGE_TOOLS = new Set(['browser_capture_element', 'browser_captcha_capture']);

function imageBlock(data, mimeType) {
  return { type: 'image', data, mimeType: typeof mimeType === 'string' ? mimeType : 'image/png' };
}

export async function mcpToolCall(name, args, rawCall) {
  const effectiveArgs = name === 'browser_wait_until_ready'
    ? { ...args, timeoutMs: Math.min(args.timeoutMs ?? 20000, 20000) }
    : args;
  const response = await rawCall(name, effectiveArgs);
  const result = response?.result ?? response;
  if (name === 'browser_screenshot' && typeof result?.data === 'string' && !result.status) {
    return { content: [imageBlock(result.data, 'image/png')] };
  }
  if (IMAGE_TOOLS.has(name) && typeof result?.data === 'string' && !result.status) {
    const { data, ...meta } = result;
    return { content: [imageBlock(data, result.mimeType), { type: 'text', text: JSON.stringify(meta) }] };
  }
  if (name === 'browser_captcha_read_character' && typeof result?.image?.data === 'string') {
    const meta = { ...result, image: { ...result.image, data: undefined } };
    return { content: [imageBlock(result.image.data, result.image.mimeType), { type: 'text', text: JSON.stringify(meta) }] };
  }
  return { content: [{ type: 'text', text: JSON.stringify(result) }] };
}
