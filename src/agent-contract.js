import { readFileSync } from 'node:fs';

export const CONTRACT_URI = 'bridge://skills/ai-browser-bridge';
export const AGENT_CONTRACT = readFileSync(new URL('../skills/ai-browser-bridge/SKILL.md', import.meta.url), 'utf8');
