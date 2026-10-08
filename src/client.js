import { loadConfig } from './config.js';
export async function request(path, data) {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    throw new Error(`Bridge configuration is missing or unreadable (${error.message}). Run 'node src/cli.js setup' then start.ps1.`);
  }
  const base = `http://127.0.0.1:${config.port}`;
  let res;
  try {
    res = await fetch(`${base}${path}`, {
      method: data ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${config.agentToken}`, ...(data ? { 'Content-Type': 'application/json' } : {}) },
      body: data ? JSON.stringify(data) : undefined,
      signal: AbortSignal.timeout(360000)
    });
  } catch (error) {
    const reason = /timeout|abort/i.test(error.message) ? 'timed out' : 'is not listening or refused the connection';
    throw new Error(`Bridge service ${reason} on ${base} (${error.message}). State: service-down. Start it with start.ps1 (or 'node src/server.js'), then re-check with 'node src/cli.js doctor'. If the service is up but the extension is disconnected, doctor reports extension-disconnected instead.`);
  }
  let result;
  try {
    result = await res.json();
  } catch (error) {
    const text = await res.text().catch(() => '');
    throw new Error(`Bridge returned a non-JSON response (HTTP ${res.status}) from ${path}: ${text.slice(0, 200) || error.message}`);
  }
  if (!res.ok) throw new Error(result.error || `HTTP ${res.status}`);
  return result;
}
