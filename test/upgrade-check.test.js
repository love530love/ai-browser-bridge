import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildUpgradeCheck } from '../src/upgrade-check.js';

function healthyContext() {
  return {
    disk: { version: '0.39.0', manifestVersion: '0.39.0', buildId: 'disk-build-aaa' },
    running: {
      version: '0.39.0',
      buildId: 'disk-build-aaa',
      extensionVersion: '0.39.0',
      connected: true,
      extensionId: 'gklebbcjecmlmcdihciilbmjjbmjggip'
    },
    config: { missingFields: [], defaults: { uploadRoots: [], uploadMaxBytes: 16777216 } },
    git: { head: '3802e3e', behind: 0, ahead: 0, dirty: false },
    extensionId: 'gklebbcjecmlmcdihciilbmjjbmjggip'
  };
}

test('all layers healthy -> ok:true, steps keep only the re-verification', () => {
  const report = buildUpgradeCheck(healthyContext());
  assert.equal(report.ok, true);
  assert.equal(report.steps.length, 1);
  assert.equal(report.steps[0].layer, 'verify');
  assert.match(report.steps[0].command, /doctor-lite\.bat && doctor\.bat/);
  assert.equal(report.layers['version-sync'].ok, true);
  assert.equal(report.layers.service.ok, true);
  assert.equal(report.layers.extension.ok, true);
  assert.equal(report.layers.config.ok, true);
});

test('disk version vs manifest version mismatch -> 四处版本未同步 step', () => {
  const ctx = healthyContext();
  ctx.disk.manifestVersion = '0.38.0';
  const report = buildUpgradeCheck(ctx);
  assert.equal(report.ok, false);
  assert.equal(report.layers['version-sync'].ok, false);
  const step = report.steps.find(s => s.layer === 'version-sync');
  assert.ok(step);
  assert.match(step.problem, /四处版本未同步/);
  assert.ok(step.command.trim().length > 0);
});

test('running=null -> 服务不可达 step, no crash, no extension step', () => {
  const ctx = healthyContext();
  ctx.running = null;
  const report = buildUpgradeCheck(ctx);
  assert.equal(report.ok, false);
  const step = report.steps.find(s => s.layer === 'service');
  assert.ok(step);
  assert.match(step.problem, /服务不可达/);
  assert.match(step.command, /start\.bat/);
  assert.match(`${step.command} ${step.note}`, /doctor-lite\.bat/);
  // With no service answer there is no evidence about the extension version,
  // so no extension reload step is fabricated.
  assert.equal(report.steps.some(s => s.layer === 'extension'), false);
});

test('buildId mismatch -> read-only identity check, never a blind kill by server.pid', () => {
  const ctx = healthyContext();
  ctx.running.buildId = 'old-build-111';
  const report = buildUpgradeCheck(ctx);
  const step = report.steps.find(s => s.layer === 'service');
  assert.ok(step);
  // A stale server.pid can point at a dead process while another node owns the
  // port. The copyable command must be read-only (status + LISTENING-PID
  // evidence), never a blind kill by that file. The note carries the gated
  // decision: compare PIDs, confirm cmdline + idle, else only report, then
  // delegate the restart to the watchdog and never use stop.ps1.
  assert.doesNotMatch(step.command, /process\.kill/);
  assert.doesNotMatch(step.command, /SIGTERM/);
  assert.doesNotMatch(step.command, /taskkill/i);
  assert.match(step.command, /node src\/cli\.js status/);
  assert.match(step.command, /netstat -ano -p TCP \| findstr 19387/);
  assert.match(step.note, /LISTENING PID/);
  assert.match(step.note, /src\/server\.js/);
  assert.match(step.note, /完全空闲|queued=0/);
  assert.match(step.note, /不是进程存活证据/);
  assert.match(step.note, /只报告/);
  assert.match(step.note, /绝不终止不明进程/);
  assert.match(step.note, /看门狗/);
  assert.match(step.note, /绝对不要用 stop\.ps1/);
  assert.match(step.note, /service-paused/);
  assert.equal(report.layers.service.buildIdCurrent, false);
});

test('extension version lag -> reload step with per-hostId note', () => {
  const ctx = healthyContext();
  ctx.running.extensionVersion = '0.38.0';
  const report = buildUpgradeCheck(ctx);
  const step = report.steps.find(s => s.layer === 'extension');
  assert.ok(step);
  assert.match(step.command, /browser_reload_extension/);
  assert.match(step.command, /reload_extension_once/);
  assert.match(step.note, /hostId/);
  assert.equal(report.layers.extension.versionCurrent, false);
});

test('each config.missingFields field -> one copyable config step', () => {
  const ctx = healthyContext();
  ctx.config.missingFields = ['browserTarget', 'uploadRoots', 'uploadMaxBytes'];
  const report = buildUpgradeCheck(ctx);
  const cfgSteps = report.steps.filter(s => s.layer === 'config');
  assert.equal(cfgSteps.length, 3);
  assert.ok(cfgSteps.some(s => /browserTarget/.test(s.problem) && /set-browser-target --from-running-chrome/.test(s.command)));
  for (const step of cfgSteps) {
    assert.equal(typeof step.command, 'string');
    assert.ok(step.command.trim().length > 0, `missing command for ${step.problem}`);
  }
  assert.equal(report.layers.config.ok, false);
});

test('all layers lagging -> ordered steps, every step has command, verify is last', () => {
  const ctx = healthyContext();
  ctx.disk.manifestVersion = '0.38.0';
  ctx.running.buildId = 'old-build';
  ctx.running.extensionVersion = '0.37.4';
  ctx.config.missingFields = ['browserTarget', 'uploadMaxBytes'];
  const report = buildUpgradeCheck(ctx);
  assert.equal(report.ok, false);
  assert.equal(report.steps.at(-1).layer, 'verify');

  const layerOrder = ['version-sync', 'service', 'extension', 'config', 'verify'];
  const indexOf = layer => report.steps.findIndex(s => s.layer === layer);
  for (let i = 0; i < layerOrder.length - 1; i += 1) {
    assert.ok(indexOf(layerOrder[i]) < indexOf(layerOrder[i + 1]), `${layerOrder[i]} must precede ${layerOrder[i + 1]}`);
  }
  report.steps.forEach((step, i) => {
    assert.equal(step.order, i + 1);
    assert.equal(typeof step.layer, 'string');
    assert.equal(typeof step.problem, 'string');
    assert.equal(typeof step.command, 'string');
    assert.ok(step.command.trim().length > 0, `step ${step.order} has no copyable command`);
    assert.equal(typeof step.note, 'string');
  });
  assert.match(report.steps.at(-1).command, /doctor-lite\.bat && doctor\.bat/);
});

test('empty input does not crash and still ends with re-verification', () => {
  const report = buildUpgradeCheck();
  assert.equal(typeof report.ok, 'boolean');
  assert.equal(report.steps.at(-1).layer, 'verify');
  for (const step of report.steps) assert.equal(typeof step.command, 'string');
});
