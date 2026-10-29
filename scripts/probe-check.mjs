// Proves the port probe in extension/worker.js behaves correctly against a real
// socket, using the function body read out of the source rather than a copy.
import { readFileSync } from 'node:fs';
import net from 'node:net';

const src = readFileSync(new URL('../extension/worker.js', import.meta.url), 'utf8');
const start = src.indexOf('async function serviceListening');
const end = src.indexOf('\nasync function connect(', start);
if (start < 0 || end < 0) throw new Error('serviceListening not found in worker.js');
const serviceListening = new Function(`${src.slice(start, end)}; return serviceListening;`)();

const timed = async (label, port, expected) => {
  const t0 = Date.now();
  const got = await serviceListening(port);
  const ms = Date.now() - t0;
  const ok = got === expected;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(46)} port=${port} listening=${got} expected=${expected} ${ms}ms`);
  return ok;
};

// A socket that accepts the TCP connection and then never answers: the probe
// must give up on its own instead of stalling the reconnect loop forever.
const silent = net.createServer(() => { /* accept and stay mute */ });
await new Promise(resolve => silent.listen(0, '127.0.0.1', resolve));
const silentPort = silent.address().port;

const results = [];
results.push(await timed('running bridge service', 19387, true));
results.push(await timed('closed port (nothing listening)', 19399, false));
results.push(await timed('port that accepts but never answers', silentPort, false));
silent.close();

console.log(results.every(Boolean) ? '\nALL PASS' : '\nSOME FAILED');
process.exit(results.every(Boolean) ? 0 : 1);
