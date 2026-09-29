import { loadConfig } from './config.js';
export async function request(path, data) {
  const config = loadConfig();
  const res = await fetch(`http://127.0.0.1:${config.port}${path}`, {
    method: data ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${config.agentToken}`, ...(data ? { 'Content-Type': 'application/json' } : {}) },
    body: data ? JSON.stringify(data) : undefined,
    signal: AbortSignal.timeout(360000)
  });
  const result = await res.json();
  if (!res.ok) throw new Error(result.error || `HTTP ${res.status}`);
  return result;
}
