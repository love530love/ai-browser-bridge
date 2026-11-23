// Discovery is a surface property, so these tests read the shipped catalogue
// directly. A weak caller that only sees the first batch must still be able to
// reach every capability: core first, complete list, local search, exact schema,
// and a structured failure for a guessed name. No browser is involved.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TOOLS, validateCall, suggestToolNames } from '../src/tools.js';
import { TOOL_GROUPS } from '../src/tool-index.js';
import {
  CORE_TOOL_PROFILE, listToolsOrdered, searchTools, getToolSchema, toolSurfaceMeta, capabilityManifest
} from '../src/tool-surface.js';
import { createBridge } from '../src/server.js';
import { runWeakAgentBenchmark } from './bench/weak-agent.js';

const coreSet = new Set(CORE_TOOL_PROFILE);

test('tools/list starts with a discovery-capable core and still contains every tool', () => {
  const ordered = listToolsOrdered();
  assert.deepEqual(ordered.slice(0, CORE_TOOL_PROFILE.length).map(tool => tool.name), CORE_TOOL_PROFILE);
  assert.equal(ordered.length, TOOLS.length);
  assert.equal(new Set(ordered.map(tool => tool.name)).size, TOOLS.length, 'no tool is duplicated or dropped');
  // The two tools that make the rest reachable must be on the front page.
  assert.ok(CORE_TOOL_PROFILE.includes('browser_tool_search'));
  assert.ok(CORE_TOOL_PROFILE.includes('browser_tool_schema'));
  assert.ok(CORE_TOOL_PROFILE.includes('browser_tool_index'));
  // No extension-dispatched tool may be replaced by a discovery tool.
  for (const name of ['browser_click_verified', 'browser_upload_verified', 'browser_read']) {
    assert.ok(ordered.some(tool => tool.name === name), `${name} remains listed`);
  }
});

test('every core name is a real tool and every group enum value is a real group', () => {
  for (const name of CORE_TOOL_PROFILE) assert.ok(TOOLS.some(tool => tool.name === name), `${name} is registered`);
  const declared = new Set(TOOLS.find(tool => tool.name === 'browser_tool_index').inputSchema.properties.group.enum);
  assert.deepEqual([...declared].sort(), TOOL_GROUPS.map(group => group.id).sort());
  const searchDeclared = new Set(TOOLS.find(tool => tool.name === 'browser_tool_search').inputSchema.properties.group.enum);
  assert.deepEqual([...searchDeclared].sort(), TOOL_GROUPS.map(group => group.id).sort());
});

test('search finds deep catalogue tools that are absent from the first batch', () => {
  const cases = [
    ['上传附件', 'browser_upload_verified'],
    ['把页面保存成 PDF', 'browser_pdf_save'],
    ['下载这个链接里的文件', 'browser_download_url'],
    ['读取 localStorage', 'browser_storage_read'],
    ['打开 chrome://settings 改代理', 'browser_native_snapshot'],
    ['给页面打个断点', 'browser_debugger'],
    ['读一下 IndexedDB', 'browser_storage_read']
  ];
  for (const [goal, expected] of cases) {
    assert.ok(!coreSet.has(expected), `${expected} is deliberately outside the core profile`);
    const result = searchTools({ query: goal, limit: 10 });
    assert.equal(result.status, 'success', goal);
    assert.ok(result.results.some(entry => entry.name === expected), `${goal} should find ${expected}: ${result.results.map(entry => entry.name).join(', ')}`);
    assert.equal(result.coverage.complete, true);
  }
});

test('search reports a named basis and never invents a probability', () => {
  const result = searchTools({ query: '上传附件', limit: 5 });
  for (const entry of result.results) {
    assert.ok(entry.basis.length > 0, `${entry.name} has a basis`);
    assert.equal(typeof entry.score, 'number');
    assert.ok(!('probability' in entry) && !('confidence' in entry));
  }
  // A caller that finds the diagnostic twin must be able to see the verified
  // twin without knowing the naming convention.
  const diagnostic = searchTools({ query: 'browser_upload', limit: 5 }).results.find(entry => entry.name === 'browser_upload');
  assert.equal(diagnostic.verifiedVariant, 'browser_upload_verified');
});

test('a group filter narrows search, and an unknown group is refused with the real ids', () => {
  const onlyDownload = searchTools({ query: '下载', group: 'download', limit: 20 });
  assert.equal(onlyDownload.status, 'success');
  assert.ok(onlyDownload.results.every(entry => entry.group === 'download'));
  const denied = searchTools({ query: '下载', group: 'nope' });
  assert.equal(denied.status, 'denied');
  assert.equal(denied.reason, 'unknown_group');
  assert.deepEqual(denied.known.sort(), TOOL_GROUPS.map(group => group.id).sort());
});

test('the exact schema is returned with required and optional arguments', () => {
  const schema = getToolSchema('browser_upload_verified');
  assert.equal(schema.status, 'success');
  assert.equal(schema.tool.name, 'browser_upload_verified');
  assert.deepEqual(schema.required, schema.tool.inputSchema.required);
  assert.ok(schema.required.includes('tabId'));
  assert.ok(schema.optional.includes('selector') || schema.optional.includes('inputIndex'));
  assert.ok(schema.tool.description.length > 100);
  const twin = getToolSchema('browser_upload');
  assert.equal(twin.verifiedVariant, 'browser_upload_verified');
  assert.match(twin.note, /diagnostic/);
});

test('an unknown schema name gets suggestions and a search nextStep, not a bare error', () => {
  const schema = getToolSchema('browser_upload_file');
  assert.equal(schema.status, 'not_found');
  assert.equal(schema.reason, 'unknown_tool');
  assert.ok(schema.suggestedTools.includes('browser_upload_verified'));
  assert.equal(schema.nextStep.tool, 'browser_tool_search');
  assert.equal(schema.nextStep.arguments.query, 'browser_upload_file');
});

test('an unknown tool call carries the same recovery fields every entry point can see', () => {
  assert.throws(() => validateCall('browser_upload_file', {}), error => {
    assert.equal(error.code, 'UNKNOWN_TOOL');
    assert.equal(error.reason, 'unknown_tool');
    assert.ok(error.suggestedTools.includes('browser_upload_verified'));
    assert.equal(error.nextStep.tool, 'browser_tool_search');
    assert.equal(error.nextStep.arguments.query, 'browser_upload_file');
    assert.equal(error.toolSurface.search, 'browser_tool_search');
    return true;
  });
  assert.ok(suggestToolNames('browser_clik').includes('browser_click'));
});

test('the service answers search and schema locally while the bridge is disconnected', async t => {
  const bridge = createBridge({ port: 0, agentToken: 'fixture', extensionToken: 'fixture' }, {
    leaseStateFile: null, agentPolicyFile: null, audit: () => {}
  });
  await bridge.listen();
  t.after(() => bridge.close());
  const search = await bridge.call('browser_tool_search', { query: '上传附件', limit: 10 });
  assert.equal(search.status, 'success');
  assert.ok(search.results.some(entry => entry.name === 'browser_upload_verified'));
  const schema = await bridge.call('browser_tool_schema', { name: 'browser_upload_verified' });
  assert.equal(schema.status, 'success');
  const guide = await bridge.call('browser_agent_guide', {});
  assert.ok(guide.discoveryProtocol);
  assert.ok(guide.discoveryProtocol.conclusionRule.includes('Never report a capability as missing'));
  assert.equal(guide.toolSurface.toolCount, TOOLS.length);
  // validateCall is the single funnel, so the unknown name is refused before a
  // promise exists; asserting the throw keeps that synchronous contract pinned.
  assert.throws(() => bridge.call('browser_upload_file', {}), error => {
    assert.equal(error.code, 'UNKNOWN_TOOL');
    assert.ok(error.suggestedTools.includes('browser_upload_verified'));
    return true;
  });
});

test('the capability manifest is machine-readable and lists every group', () => {
  const manifest = capabilityManifest();
  assert.equal(manifest.toolCount, TOOLS.length);
  assert.deepEqual(manifest.groups.map(group => group.id), TOOL_GROUPS.map(group => group.id));
  assert.equal(manifest.discovery.allToolsReachable, true);
  assert.ok(manifest.integrityStops.some(line => /uncertain write/i.test(line)));
  assert.match(manifest.warningPolicy, /advisory/i);
});

test('tool surface metadata can prove the running process matches the disk', () => {
  const meta = toolSurfaceMeta();
  assert.equal(meta.toolCount, TOOLS.length);
  assert.equal(meta.coreToolCount, CORE_TOOL_PROFILE.length);
  assert.match(meta.toolSurfaceHash, /^[a-f0-9]{16}$/);
  assert.ok(meta.mcpProcessStartedAt);
  assert.equal(meta.discovery.allToolsSearchable, true);
  // A same-version process that started after the last source edit is current.
  // The field exists so a stale process is visible instead of silently serving
  // an old schema, which is the field-report failure this metadata answers.
  assert.equal(typeof meta.staleToolSurface, 'boolean');
});

test('a weak agent that sees only the core profile recovers, and the legacy flow does not', () => {
  const report = runWeakAgentBenchmark();
  const [legacy, current] = report.scenarios;
  assert.equal(legacy.stuckRate, 1, 'the old bare unknown-tool sentence leaves every task stuck');
  assert.equal(current.stuck, 0, 'search and suggestions recover every task');
  assert.equal(current.successRate, 1);
  assert.equal(current.falseSuccess, 0);
  assert.ok(current.recovered > legacy.recovered);
  // The benchmark is a deterministic regression harness, not a model scorecard.
  const source = readFileSync(new URL('./bench/weak-agent.js', import.meta.url), 'utf8');
  assert.match(source, /does not call a language model/);
});
