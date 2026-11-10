import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SCRIPT = join(ROOT, 'scripts', 'doctor-host-env.mjs');
const BAT = join(ROOT, 'doctor-lite.bat');
const REQUIRED_NAMES = ['pwsh-7', 'node-22', 'runtime-pinned', 'autostart-registry', 'port-19387', 'no-proxy-loopback'];

// 所有输入都落在 mkdtemp 临时目录里，绝不触碰用户真实 .local/ 或注册表。
function makeSandbox(opts = {}) {
  const {
    withConfig = true, withRuntime = true, withAutostart = true,
    runtimePathsExist = true, appdataLink = false, port = 61999
  } = opts;
  const dir = mkdtempSync(join(tmpdir(), 'aib-doctor-lite-'));
  const state = join(dir, 'state');
  const appdata = join(dir, 'appdata');
  const startup = join(appdata, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  mkdirSync(state, { recursive: true });
  mkdirSync(startup, { recursive: true });
  const token = randomBytes(32).toString('hex');
  if (appdataLink) writeFileSync(join(startup, 'AI Browser Bridge.lnk'), 'stub');
  if (withConfig) {
    writeFileSync(join(state, 'config.json'), JSON.stringify({
      port, agentToken: token, extensionToken: randomBytes(32).toString('hex'), uploadRoots: []
    }));
  }
  if (withRuntime) {
    const node = runtimePathsExist ? process.execPath : join(dir, 'missing-node.exe');
    const pwsh = runtimePathsExist ? process.execPath : join(dir, 'missing-pwsh.exe');
    writeFileSync(join(state, 'runtime.json'), JSON.stringify({ pwsh, node, resolvedAt: '2026-11-10T00:00:00.000Z' }));
  }
  if (withAutostart) {
    writeFileSync(join(state, 'autostart-registry.json'), JSON.stringify({
      version: 1, updatedAt: '2026-11-10T00:00:00.000Z',
      entries: [{ kind: 'startup-shortcut', path: join(state, 'x.lnk'), arguments: '-NoProfile' }]
    }));
  }
  return { dir, state, appdata, token, port };
}

function runDoctor(box, extraEnv = {}) {
  // Windows 环境变量大小写不敏感：先剔除所有大小写代理变量，再统一用大写键精确覆盖。
  const cleanEnv = { ...process.env };
  for (const k of Object.keys(cleanEnv)) {
    if (/^(NO_PROXY|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY)$/i.test(k)) delete cleanEnv[k];
  }
  return spawnSync(process.execPath, [SCRIPT, '--json'], {
    encoding: 'utf8',
    timeout: 60000,
    env: {
      ...cleanEnv,
      AIB_STATE_DIR: box.state,
      APPDATA: box.appdata,
      NO_PROXY: '', HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
      ...extraEnv
    }
  });
}

function parseReport(result) {
  assert.equal(result.error, undefined, `脚本启动失败：${result.error && result.error.message}`);
  const text = result.stdout ?? '';
  let report;
  try { report = JSON.parse(text); }
  catch (error) { assert.fail(`--json 输出不是合法 JSON：${error.message}\n${text.slice(0, 500)}`); }
  return { report, text };
}

function cleanup(box) { rmSync(box.dir, { recursive: true, force: true }); }

test('真实跑 --json：结构/检查名/fix/unknown 语义/零 pwsh 依赖/不泄露凭据', () => {
  const box = makeSandbox({ appdataLink: false });
  try {
    const { report, text } = parseReport(runDoctor(box));
    assert.equal(report.service, 'ai-browser-bridge');
    assert.equal(typeof report.ok, 'boolean');
    assert.ok(Array.isArray(report.checks));
    for (const n of REQUIRED_NAMES) assert.ok(report.checks.some(c => c.name === n), `缺少检查项 ${n}`);
    assert.equal(report.checks.length, REQUIRED_NAMES.length);
    for (const c of report.checks) {
      assert.ok(c.ok === true || c.ok === false || c.ok === null, `${c.name}.ok 必须是 true/false/null`);
      assert.equal(typeof c.status, 'string');
      assert.ok(c.status.length > 0);
      assert.equal(typeof c.detail, 'string');
      assert.ok(c.detail.length > 0, `${c.name}.detail 为空`);
      assert.equal(typeof c.fix, 'string');
    }
    for (const c of report.checks.filter(c => c.ok === false)) {
      assert.ok(c.fix.trim().length > 0, `${c.name} 为 false 却没有非空 fix`);
    }
    const noProxy = report.checks.find(c => c.name === 'no-proxy-loopback');
    assert.equal(noProxy.ok, false);
    assert.match(noProxy.fix, /setx NO_PROXY "127\.0\.0\.1,localhost,::1"/, '修复命令应可直接复制');
    // unknown 项不把整体 ok 判成 false：ok 只由「是否存在 false 项」决定
    assert.equal(report.ok, !report.checks.some(c => c.ok === false));
    assert.equal(report.exitCode, report.ok ? 0 : 1);
    assert.match(report.note, /pwsh/);
    assert.match(report.note, /PowerShell 7/);

    const src = readFileSync(SCRIPT, 'utf8');
    // 脚本源码不调用 pwsh.exe / powershell.exe / .ps1（零 pwsh 运行依赖）
    assert.doesNotMatch(src, /(?:spawnSync|execFile|exec|spawn)\(\s*['"`]pwsh/i);
    assert.doesNotMatch(src, /powershell\.exe/i);
    assert.doesNotMatch(src, /\.ps1['"`]/i);
    assert.match(src, /where\.exe/);
    assert.match(src, /Authorization/);
    assert.match(src, /Bearer/);
    // .bat 不含 pwsh 字样、不依赖 PowerShell、不 call 公共头、直接调 node.exe
    const bat = readFileSync(BAT, 'utf8');
    assert.doesNotMatch(bat, /pwsh/i);
    assert.doesNotMatch(bat, /powershell/i);
    assert.doesNotMatch(bat, /check-runtime\.bat/i);
    assert.match(bat, /chcp 65001/);
    assert.match(bat, /node\.exe/);
    assert.match(bat, /scripts\\doctor-host-env\.mjs/);
    // 输出不泄露凭据：既不含本次构造的 token，也不含任何凭据形态的 64 位十六进制串
    assert.ok(!text.includes(box.token), '--json 输出泄露了 config 里的凭据字面量');
    assert.doesNotMatch(text, /[a-f0-9]{64}/i, '输出不应包含凭据形态的 64 位十六进制串');
  } finally { cleanup(box); }
});

test('no-proxy 与 autostart 启动文件夹在不同输入下给出不同结果（开/关不同）', () => {
  const boxOff = makeSandbox({ appdataLink: false });
  const boxOn = makeSandbox({ appdataLink: true });
  try {
    const off = parseReport(runDoctor(boxOff)).report;
    const on = parseReport(runDoctor(boxOff, { NO_PROXY: '127.0.0.1,localhost,::1' })).report;
    const offProxy = off.checks.find(c => c.name === 'no-proxy-loopback');
    const onProxy = on.checks.find(c => c.name === 'no-proxy-loopback');
    assert.equal(offProxy.ok, false, 'NO_PROXY 为空应判定未覆盖');
    assert.equal(onProxy.ok, true, 'NO_PROXY 覆盖三者应通过');
    assert.notEqual(offProxy.ok, onProxy.ok, '开与关应给出不同结论');
    assert.equal(onProxy.missingTargets.length, 0);
    assert.deepEqual([...offProxy.missingTargets].sort(), ['127.0.0.1', 'localhost', '::1'].sort());

    const withoutLink = off.checks.find(c => c.name === 'autostart-registry');
    const withLink = parseReport(runDoctor(boxOn)).report.checks.find(c => c.name === 'autostart-registry');
    assert.equal(withoutLink.external.startupShortcut.status, 'absent');
    assert.equal(withLink.external.startupShortcut.status, 'present');
    assert.notEqual(withoutLink.external.startupShortcut.status, withLink.external.startupShortcut.status);
  } finally { cleanup(boxOff); cleanup(boxOn); }
});

test('runtime / registry 缺失或 JSON 损坏时报 unknown 而非失败，且不抛异常', () => {
  const box = makeSandbox({ withRuntime: false, withAutostart: false, withConfig: true });
  try {
    writeFileSync(join(box.state, 'autostart-registry.json'), '{ broken json');
    const { report } = parseReport(runDoctor(box, { NO_PROXY: '127.0.0.1,localhost,::1' }));
    const runtime = report.checks.find(c => c.name === 'runtime-pinned');
    const autostart = report.checks.find(c => c.name === 'autostart-registry');
    assert.equal(runtime.ok, null);
    assert.equal(runtime.status, 'unknown');
    assert.equal(autostart.ok, null);
    assert.equal(autostart.status, 'unknown');
    assert.ok(report.unknownCount >= 2, '应至少有两个 unknown 项');
    // 即便有 unknown 项，整体 ok 仍只由 false 项决定，且脚本完整输出未崩溃
    assert.equal(report.ok, !report.checks.some(c => c.ok === false));
    assert.equal(report.checks.length, REQUIRED_NAMES.length);
  } finally { cleanup(box); }
});

test('缺 config.json 时服务四态为 not_installed 且带 setup 修复命令', () => {
  const box = makeSandbox({ withConfig: false, withRuntime: false, withAutostart: false });
  try {
    const { report } = parseReport(runDoctor(box));
    const c = report.checks.find(x => x.name === 'port-19387');
    assert.equal(c.serviceState, 'not_installed');
    assert.equal(c.ok, false);
    assert.match(c.fix, /setup/);
    assert.equal(c.port, null);
  } finally { cleanup(box); }
});

test('端口有监听且带凭据 /status 通过时判 running，并确认脚本携带 Bearer 凭据', async () => {
  const box = makeSandbox({ withConfig: true, withRuntime: false, withAutostart: false });
  const eventsFile = join(box.dir, 'server-events.log');
  const portFile = join(box.dir, 'server-port.txt');
  // token 由子进程从 config.json 读取，绝不拼进命令行；父进程被 spawnSync 阻塞，故服务必须在独立进程。
  const serverCode = [
    "const http=require('node:http'),fs=require('node:fs'),path=require('node:path');",
    "const state=process.env.DOCTOR_TEST_STATE,cfg=JSON.parse(fs.readFileSync(path.join(state,'config.json'),'utf8'));",
    "const token=cfg.agentToken,events=process.env.DOCTOR_TEST_EVENTS,pf=process.env.DOCTOR_TEST_PORTFILE;",
    "http.createServer((req,res)=>{",
    "  fs.appendFileSync(events,(req.headers.authorization||'MISSING')+String.fromCharCode(10));",
    "  if(req.headers.authorization==='Bearer '+token){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({service:'ai-browser-bridge',version:'0.37.2',connected:true}));}",
    "  else{res.writeHead(401,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'Authentication required'}));}",
    "}).listen(0,'127.0.0.1',function(){fs.writeFileSync(pf,String(this.address().port));});"
  ].join('\n');
  const child = spawn(process.execPath, ['-e', serverCode], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, DOCTOR_TEST_STATE: box.state, DOCTOR_TEST_EVENTS: eventsFile, DOCTOR_TEST_PORTFILE: portFile }
  });
  let childErr = '';
  child.stderr.on('data', d => { childErr += d; });
  try {
    const deadline = Date.now() + 8000;
    while (!existsSync(portFile)) {
      if (Date.now() > deadline) assert.fail(`测试服务未就绪：${childErr}`);
      await new Promise(r => setTimeout(r, 30));
    }
    const port = Number(readFileSync(portFile, 'utf8').trim());
    const configPath = join(box.state, 'config.json');
    const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
    cfg.port = port;
    writeFileSync(configPath, JSON.stringify(cfg));

    const { report, text } = parseReport(runDoctor(box, { NO_PROXY: '127.0.0.1,localhost,::1' }));
    const c = report.checks.find(x => x.name === 'port-19387');
    assert.equal(c.serviceState, 'running', `期望 running，实际 ${c.serviceState}；detail=${c.detail}`);
    assert.equal(c.ok, true);
    // 断言里不出现任何 token 字面量：每个请求都应是标准 Bearer 凭据，且没有裸请求
    const events = readFileSync(eventsFile, 'utf8');
    const lines = events.split(/\r?\n/).filter(Boolean);
    assert.ok(lines.length > 0, '服务端未收到任何 /status 请求');
    for (const line of lines) assert.match(line, /^Bearer [a-f0-9]{64}$/, '脚本未携带 Bearer 凭据（用了裸 GET？）');
    assert.doesNotMatch(events, /MISSING/);
    assert.doesNotMatch(text, /[a-f0-9]{64}/i);
  } finally {
    child.kill();
    await new Promise(resolve => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', resolve);
      setTimeout(resolve, 1500);
    });
    cleanup(box);
  }
});
