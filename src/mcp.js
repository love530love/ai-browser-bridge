import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { validateCall } from './tools.js';
import { request } from './client.js';
import { recoverRead } from './read-recovery.js';
import { VERSION } from './version.js';
import { mcpToolCall } from './mcp-call.js';
import { AGENT_CONTRACT, CONTRACT_URI, CAPABILITY_URI, INITIALIZE_INSTRUCTIONS } from './agent-contract.js';
import { createAdapterRegistry } from './adapter-registry.js';
import { createParentGuard } from './mcp-parent-guard.js';
import {
  listToolsOrdered, toolSurfaceMeta, searchTools, getToolSchema, capabilityManifest, errorSurfaceFields
} from './tool-surface.js';

const server = new Server({ name: 'ai-browser-bridge', version: VERSION }, { capabilities: { tools: {}, resources: {} }, instructions: INITIALIZE_INSTRUCTIONS });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listToolsOrdered(), _meta: { toolSurface: toolSurfaceMeta() } }));
server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [
  { uri: CONTRACT_URI, name: 'ai-browser-bridge', description: 'Full browser operating skill. Initialization instructions carry the compact contract.', mimeType: 'text/markdown' },
  { uri: CAPABILITY_URI, name: 'ai-browser-bridge-capabilities', description: 'Machine-readable capability manifest: tool count, core profile, groups, discovery order and integrity stops.', mimeType: 'application/json' }
] }));
server.setRequestHandler(ReadResourceRequestSchema, async ({ params }) => {
  if (params.uri === CONTRACT_URI) return { contents: [{ uri: CONTRACT_URI, mimeType: 'text/markdown', text: AGENT_CONTRACT }] };
  if (params.uri === CAPABILITY_URI) return { contents: [{ uri: CAPABILITY_URI, mimeType: 'application/json', text: JSON.stringify(capabilityManifest(), null, 2) }] };
  throw new Error('Unknown contract resource');
});
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  try {
    const args = params.arguments ?? {};
    validateCall(params.name, args);
    // Discovery must still work when the bridge service is down or stalled.
    // Both tools read the imported catalogue only and never touch a browser.
    if (params.name === 'browser_tool_search' || params.name === 'browser_tool_schema') {
      const result = params.name === 'browser_tool_search'
        ? searchTools({ query: args.query, group: args.group, limit: args.limit })
        : getToolSchema(args.name);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
    return await mcpToolCall(params.name, args,
      (name, effectiveArgs) => recoverRead(name, () => request('/call', { name, arguments: effectiveArgs })));
  } catch (e) {
    // Keep isError so the client still sees a failure, but hand back the same
    // shape a returned failure has: a status, the message, and one nextStep.
    // A bare sentence is what a weak caller cannot act on.
    const fields = errorSurfaceFields(e);
    const text = e.nextStep || e.code
      ? JSON.stringify({ status: 'failed', retryable: false, error: e.message, ...fields })
      : e.message;
    return { isError: true, content: [{ type: 'text', text }] };
  }
});
// This stdio adapter belongs to one client, not to the shared bridge service.
// EOF means its owner is gone. Outstanding HTTP sockets must not keep it alive.
// The registry carries the guard's mode so an operator can see active vs
// passive protection without attaching to the adapter.
let parentGuard = null;
const adapterRegistry = createAdapterRegistry({
  status: () => ({ guard: parentGuard?.snapshot() ?? null })
});
try { adapterRegistry.start(); } catch {}
// An adapter whose client vanished without closing the pipe would otherwise
// live forever. The guard walks launcher/wrapper-shell ancestors to a stable
// client and exits this adapter when that exact process dies.
parentGuard = createParentGuard({ onOrphan: () => closeClient() });
try { parentGuard.start(); } catch {}
process.once('exit', () => { try { adapterRegistry.stop(); } catch {} try { parentGuard.stop(); } catch {} });
let closing = false;
function closeClient() {
  if (closing) return;
  closing = true;
  adapterRegistry.stop();
  const deadline = setTimeout(() => process.exit(0), 1000);
  server.close().catch(() => {}).finally(() => {
    clearTimeout(deadline);
    process.exit(0);
  });
}
process.stdin.once('end', closeClient);
process.stdin.once('close', closeClient);
process.stdout.on('error', error => {
  if (error.code === 'EPIPE' || error.code === 'ERR_STREAM_DESTROYED') closeClient();
});
await server.connect(new StdioServerTransport());
