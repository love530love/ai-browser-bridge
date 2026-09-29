// Independent literal-only adapter for the public Open-AutoGLM action format.
// It never evaluates model output as JavaScript, Python or shell code.
export function parseAction(input) {
  if (typeof input !== 'string' || input.length > 30000) throw new Error('Invalid action output');
  let source = input.trim().replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```$/, '').trim();
  if (source.startsWith('{')) return JSON.parse(source);
  const match = /^(do|finish)\s*\(/.exec(source);
  if (!match) throw new Error('Expected a JSON action or literal do()/finish()');
  let i = match[0].length;
  const skip = () => { while (/\s/.test(source[i] || '') && i < source.length) i++; };
  function value(depth = 0) {
    if (depth > 2) throw new Error('Action nesting too deep');
    skip(); const quote = source[i];
    if (quote === '"' || quote === "'") {
      i++; let result = '';
      while (i < source.length) {
        const c = source[i++]; if (c === quote) return result;
        if (c !== '\\') { result += c; continue; }
        const esc = source[i++];
        const escaped = { n: '\n', r: '\r', t: '\t', '\\': '\\', '"': '"', "'": "'" };
        if (Object.hasOwn(escaped, esc)) result += escaped[esc];
        else if (esc === 'u' && /^[a-fA-F0-9]{4}$/.test(source.slice(i, i + 4))) { result += String.fromCharCode(parseInt(source.slice(i, i + 4), 16)); i += 4; }
        else throw new Error('Unsupported string escape');
      }
      throw new Error('Unterminated string');
    }
    if (source[i] === '[') {
      i++; const result = []; skip();
      if (source[i] === ']') { i++; return result; }
      for (;;) { result.push(value(depth + 1)); skip(); if (source[i] === ']') { i++; return result; } if (source[i++] !== ',') throw new Error('Invalid literal array'); }
    }
    const number = /^-?\d+(?:\.\d+)?/.exec(source.slice(i));
    if (number) { i += number[0].length; return Number(number[0]); }
    throw new Error('Only literal strings, numbers and arrays are supported');
  }
  const result = { _metadata: match[1] === 'finish' ? 'finish' : 'do' };
  for (;;) {
    skip(); if (source[i] === ')') { i++; break; }
    const field = /^[a-zA-Z_][a-zA-Z_0-9]*/.exec(source.slice(i));
    if (!field || ['__proto__', 'prototype', 'constructor', '_metadata'].includes(field[0]) || Object.hasOwn(result, field[0])) throw new Error('Invalid or duplicate action field');
    i += field[0].length; skip(); if (source[i++] !== '=') throw new Error('Expected keyword argument');
    result[field[0]] = value(); skip();
    if (source[i] === ')') { i++; break; }
    if (source[i++] !== ',') throw new Error('Invalid action separator');
  }
  skip(); if (i !== source.length) throw new Error('Trailing executable content is not allowed');
  return result;
}
export function toBrowserAction(input, { tabId, expectedUrl }) {
  const data = typeof input === 'string' ? parseAction(input) : input;
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid action object');
  if (data._metadata === 'finish' || data.action === 'Finish') return { terminal: 'reported_complete', message: String(data.message || '') };
  if (['Take_over', 'Interact'].includes(data.action)) return { terminal: 'needs_user', message: String(data.message || 'User interaction required') };
  if (data.message) return { terminal: 'needs_user', message: String(data.message) };
  const action = data.action === 'Type_Name' ? 'Type' : data.action;
  if (!['Tap', 'Double Tap', 'Long Press', 'Hover', 'Swipe', 'Type', 'Key', 'Back', 'Wait'].includes(action)) throw new Error(`Unsupported browser action: ${action}`);
  const args = { tabId, action, expectedUrl };
  function point(name, pair) {
    if (!Array.isArray(pair) || pair.length !== 2 || pair.some(n => typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1000)) throw new Error('Coordinates must be a pair in 0..1000');
    if (name === 'end') { args.endX = pair[0]; args.endY = pair[1]; } else { args.x = pair[0]; args.y = pair[1]; }
  }
  if (['Tap', 'Double Tap', 'Long Press', 'Hover'].includes(action)) point('element', data.element);
  if (action === 'Swipe') { point('start', data.start); point('end', data.end); }
  if (action === 'Type') { if (typeof data.text !== 'string') throw new Error('Text required'); args.text = data.text; }
  if (action === 'Key') args.key = data.key;
  if (action === 'Wait') {
    const duration = /^([0-9]+(?:\.[0-9]+)?)\s*(?:seconds?)?$/.exec(String(data.duration ?? '1'));
    if (!duration || Number(duration[1]) > 5) throw new Error('Wait must be 0..5 seconds');
    args.durationMs = Math.round(Number(duration[1]) * 1000);
  }
  return { name: 'browser_action', arguments: args };
}
