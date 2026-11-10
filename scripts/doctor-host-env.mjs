// 宿主环境诊断：由 node.exe 直接运行，零 PowerShell 依赖。
// 本文件只使用 node 内置模块；对 pwsh.exe 仅通过 where.exe 探测，绝不调用它。
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
// 与 src/config.js 保持一致，便于测试用临时目录隔离，绝不触碰真实 .local/。
const stateDir = resolve(process.env.AIB_STATE_DIR || join(ROOT, '.local'));
const CMD_TIMEOUT_MS = 3000;
const PORT_PROBE_TIMEOUT_MS = 1500;
const FETCH_TIMEOUT_MS = 3000;

// 外部命令输出一律裁剪：限长 + 脱敏，杜绝凭据被原样带进报告。
function sanitize(text, limit = 1600) {
  let s = String(text ?? '')
    .replace(/[a-f0-9]{64}/gi, '[redacted]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
  if (s.length > limit) s = `${s.slice(0, limit)} ...[truncated]`;
  return s;
}

function run(file, args, timeout = CMD_TIMEOUT_MS) {
  try {
    const r = spawnSync(file, args, {
      encoding: 'utf8',
      timeout,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024
    });
    if (r.error) return { ran: false, status: null, stdout: '', stderr: sanitize(r.error.message), reason: sanitize(r.error.message) };
    return { ran: true, status: r.status, stdout: sanitize(r.stdout), stderr: sanitize(r.stderr) };
  } catch (error) {
    return { ran: false, status: null, stdout: '', stderr: '', reason: sanitize(error.message) };
  }
}

function readJson(file) {
  try {
    if (!existsSync(file)) return { present: false, value: null, error: null };
    return { present: true, value: JSON.parse(readFileSync(file, 'utf8')), error: null };
  } catch (error) {
    return { present: true, value: null, error: sanitize(error.message) };
  }
}

// where.exe 找到目标时退出码 0；找不到时退出码非 0 并给出 "Could not find" 提示；
// 命令本身跑不起来或被环境拦截时一律返回 unknown，绝不误判成「未安装」。
function whereLines(exe) {
  const r = run('where.exe', [exe]);
  if (!r.ran) return { state: 'unknown', lines: [], raw: r.stderr || r.reason || '' };
  const lines = r.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const combined = `${r.stdout}\n${r.stderr}`;
  if (r.status === 0 && lines.length) return { state: 'found', lines, raw: r.stdout };
  if (/could not find|INFO:/i.test(combined)) return { state: 'absent', lines: [], raw: combined };
  return { state: 'unknown', lines, raw: combined };
}

// 仅从路径尽力推断版本用于展示，绝不作为 ok 判定依据（精确版本需用户自行执行 --version）。
function versionFromPath(p) {
  const m = /(\d+\.\d+\.\d+(?:[-.][\w.]+)?)/.exec(p);
  return m ? m[1] : null;
}

function runtimeMatchLabel(m) {
  const labels = {
    match: '一致（固化路径与当前 node 为同一文件）',
    'present-in-where': '固化路径出现在 where.exe 候选列表中',
    mismatch: '不一致（固化路径与当前 node、where.exe 候选均不同，重启后可能选中别的二进制）',
    'runtime-unreadable': 'runtime.json 无法解析或 node 字段非绝对路径，无法比对',
    'no-runtime-file': '无 runtime.json，无法比对'
  };
  return labels[m] || m;
}

function checkPwsh() {
  const name = 'pwsh-7';
  const r = whereLines('pwsh.exe');
  if (r.state === 'found') {
    const paths = r.lines.map(p => ({ path: p, versionGuess: versionFromPath(p) }));
    const guess = paths[0].versionGuess ? `从路径推断版本约 ${paths[0].versionGuess}` : '路径中未含版本号';
    return {
      name, ok: true, status: 'ok',
      detail: `where.exe 找到 pwsh.exe，共 ${paths.length} 个候选：${paths.map(x => sanitize(x.path)).join(' | ')}。${guess}（仅供参考，精确版本请在终端执行 pwsh --version）。说明：本诊断由 node.exe 直接运行，仅用 where.exe 探测，不调用 pwsh.exe。`,
      fix: '', paths
    };
  }
  if (r.state === 'absent') {
    return {
      name, ok: false, status: 'fail',
      detail: 'where.exe pwsh 无任何结果：PATH 中找不到 pwsh.exe（PowerShell 7 未安装或未加入 PATH）。这正是 doctor.bat / start.bat 等入口打不开、一闪而过的最常见原因。',
      fix: '安装 PowerShell 7（二选一）：1) winget 安装：winget install --id Microsoft.PowerShell --source winget；2) 官方便携版 ZIP：到 https://learn.microsoft.com/powershell/scripting/install/installing-powershell-on-windows 下载 PowerShell-7.x-win-x64.zip，解压到例如 %LOCALAPPDATA%/Programs/AIBridgeRuntime，并把该目录加入用户 PATH（setx PATH "%PATH%;<解压目录>"），重开终端后重新运行本诊断。',
      paths: []
    };
  }
  return {
    name, ok: null, status: 'unknown',
    detail: `where.exe pwsh 未能得到可靠结果（${sanitize(r.raw || '命令不可用 / 被环境拦截 / 超时')}），无法判定 PowerShell 7 是否存在；按约定不把「查不到」当成失败。`,
    fix: '', paths: []
  };
}

function checkNode(runtime) {
  const name = 'node-22';
  const version = process.versions.node;
  const parts = version.split('.').map(Number);
  const major = parts[0];
  const semverParsed = Number.isInteger(major) && parts.length >= 3;
  const okMajor = semverParsed && major >= 22;
  const where = whereLines('node.exe');
  const candidates = where.state === 'found' ? where.lines : [];
  let runtimeMatch = 'no-runtime-file';
  let runtimeNode = null;
  if (runtime.present && !runtime.error && runtime.value) {
    if (typeof runtime.value.node === 'string' && isAbsolute(runtime.value.node)) {
      runtimeNode = runtime.value.node;
      const a = resolve(runtimeNode).toLowerCase();
      const b = resolve(process.execPath).toLowerCase();
      runtimeMatch = a === b ? 'match'
        : (candidates.some(c => resolve(c).toLowerCase() === a) ? 'present-in-where' : 'mismatch');
    } else {
      runtimeMatch = 'runtime-unreadable';
    }
  } else if (runtime.present) {
    runtimeMatch = 'runtime-unreadable';
  }
  const whereText = candidates.length
    ? candidates.map(sanitize).join(' | ')
    : (where.state === 'unknown' ? 'unknown（命令不可用）' : '未找到');
  return {
    name, ok: okMajor, status: okMajor ? 'ok' : 'fail',
    detail: `当前进程 node：${sanitize(process.execPath)}；版本 ${version}（解析 semver 主版本 ${major}，要求 >=22）。where.exe node 候选：${whereText}。与 .local/runtime.json 固化路径的一致性：${runtimeMatchLabel(runtimeMatch)}${runtimeNode ? `（固化路径 ${sanitize(runtimeNode)}）` : ''}。`,
    fix: okMajor ? ''
      : `当前 Node 主版本 ${major} 低于要求的 22。安装 Node.js 22 LTS：winget install --id OpenJS.NodeJS.LTS --source winget，或到 https://nodejs.org 下载 22 LTS 安装包；安装后重开终端再运行本诊断。`,
    node: { execPath: process.execPath, version, major, semverParsed, whereCandidates: candidates, whereState: where.state, runtimeNode, runtimeMatch }
  };
}

function checkRuntime(runtime) {
  const name = 'runtime-pinned';
  const empty = { pwsh: null, node: null, resolvedAt: null };
  if (!runtime.present) {
    return { name, ok: null, status: 'unknown', ...empty,
      detail: '未发现 .local/runtime.json：可能尚未执行安装 / 自启固化，或由旧版本管理。无法校验固定路径，按约定报 unknown 而非失败。',
      fix: '' };
  }
  if (runtime.error || !runtime.value || typeof runtime.value !== 'object') {
    return { name, ok: null, status: 'unknown', ...empty,
      detail: `.local/runtime.json 存在但无法解析（${sanitize(runtime.error || '结构不是对象')}），无法校验固定路径。`,
      fix: '' };
  }
  const v = runtime.value;
  const check = (key, p) => {
    if (typeof p !== 'string' || !isAbsolute(p)) return { key, path: typeof p === 'string' ? p : null, valid: false, exists: null };
    return { key, path: p, valid: true, exists: existsSync(p) };
  };
  const pwsh = check('pwsh', v.pwsh);
  const node = check('node', v.node);
  const considered = [pwsh, node].filter(x => x.valid);
  const resolvedAt = typeof v.resolvedAt === 'string' ? v.resolvedAt : null;
  if (considered.length === 0) {
    return { name, ok: null, status: 'unknown', pwsh, node, resolvedAt,
      detail: 'runtime.json 中 pwsh / node 均缺失或非绝对路径，无法校验固定路径。',
      fix: '' };
  }
  const missing = considered.filter(x => !x.exists);
  if (missing.length) {
    return { name, ok: false, status: 'fail', pwsh, node, resolvedAt,
      detail: `固定路径已失效：${missing.map(x => sanitize(x.path)).join('、')} 不存在。运行时文件被移动 / 卸载后，重启或登录自启会因找不到二进制而失败。`,
      fix: `重新固化运行时：备份后删除 .local/runtime.json，再双击 install-autostart.bat（由 install-autostart.ps1 重新解析并写入 pwsh / node 的绝对路径）让安装流程重建固化路径；注意 node src/cli.js setup 只生成 config.json、不会写 runtime.json，不要用它来修本项。也可手工把 .local/runtime.json 里的 ${missing.map(x => x.key).join('、')} 改成现存的正确绝对路径。` };
  }
  return { name, ok: true, status: 'ok', pwsh, node, resolvedAt,
    detail: `runtime.json 可读，pwsh 与 node 的固化绝对路径均仍存在（解析时间 ${sanitize(resolvedAt || 'unknown')}）。`,
    fix: '' };
}

function checkAutostart() {
  const name = 'autostart-registry';
  const reg = readJson(join(stateDir, 'autostart-registry.json'));
  const startupPath = join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'AI Browser Bridge.lnk');
  const shortcut = existsSync(startupPath) ? 'present' : 'absent';
  // 查询整个 Run 键：成功(0) 但无该值 -> absent；失败 / 被拦 / 超时 -> unknown，绝不报成失败。
  const regRun = run('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run']);
  let runEntry = 'unknown';
  if (regRun.ran && regRun.status === 0) runEntry = /AIBrowserBridge/i.test(regRun.stdout) ? 'present' : 'absent';
  // 计划任务：失败 -> unknown（沙箱常拦 schtasks.exe）。
  const task = run('schtasks.exe', ['/query', '/tn', 'AI Browser Bridge Watchdog', '/fo', 'LIST']);
  let schtask = 'unknown';
  if (task.ran && task.status === 0) schtask = /AI Browser Bridge Watchdog/i.test(task.stdout) ? 'present' : 'absent';

  let entries = [];
  let ok = true;
  let status = 'ok';
  let detail = '';
  if (!reg.present) {
    ok = null; status = 'unknown';
    detail = '未发现 .local/autostart-registry.json（可能从未安装过自启，或由旧版本管理），无法列出注册清单；按约定报 unknown。';
  } else if (reg.error || !reg.value || !Array.isArray(reg.value.entries)) {
    ok = null; status = 'unknown';
    detail = `.local/autostart-registry.json 存在但无法解析（${sanitize(reg.error || 'entries 不是数组 / 结构不符')}），无法列出注册清单。`;
  } else {
    entries = reg.value.entries.map(e => {
      const o = {};
      for (const [k, val] of Object.entries(e && typeof e === 'object' ? e : {})) o[k] = typeof val === 'string' ? sanitize(val, 400) : val;
      return o;
    });
    detail = `注册清单可读，共 ${entries.length} 项${entries.length ? `：${entries.map(x => x.kind || 'unknown').join('、')}` : '（entries 为空，通常为已卸载后的正常状态）'}。外部注册项仅报告、未做任何改动：启动文件夹快捷方式 ${shortcut}、HKCU Run(AIBrowserBridge) ${runEntry}、计划任务(AI Browser Bridge Watchdog) ${schtask}。`;
  }
  return { name, ok, status, detail, fix: '', entries,
    external: {
      startupShortcut: { path: startupPath, status: shortcut },
      registryRun: { name: 'AIBrowserBridge', status: runEntry },
      scheduledTask: { name: 'AI Browser Bridge Watchdog', status: schtask }
    } };
}

function probePort(port) {
  return new Promise(res => {
    let settled = false;
    const socket = createConnection({ host: '127.0.0.1', port });
    const finish = listening => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      res(listening);
    };
    const timer = setTimeout(() => finish(false), PORT_PROBE_TIMEOUT_MS);
    socket.setTimeout(PORT_PROBE_TIMEOUT_MS);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.once('close', () => finish(false));
  });
}

// 带 .local/config.json 里的 Bearer 凭据请求 /status；token 只进 header，绝不外泄。
async function fetchStatus(port, token) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/status`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal
    });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* 非 JSON 应答 */ }
    const ours = !!(body && typeof body === 'object' && body.service === 'ai-browser-bridge');
    return { reachable: res.status === 200 && ours, httpStatus: res.status, bodyService: body && body.service, error: null };
  } catch (error) {
    return { reachable: false, httpStatus: null, bodyService: null,
      error: error && error.name === 'AbortError' ? 'timeout' : (error && error.message) || 'fetch failed' };
  } finally {
    clearTimeout(timer);
  }
}

// netstat -ano 解析监听 PID；失败一律 unknown，绝不伪造。
function listenerPid(port) {
  const r = run('netstat.exe', ['-ano']);
  if (!r.ran || r.status !== 0) return { pid: null, note: 'netstat 不可用或执行失败，PID 记为 unknown' };
  const re = new RegExp(`^\\s*TCP\\s+\\S+[:.]${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)\\s*$`, 'i');
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = re.exec(line);
    if (m) return { pid: Number(m[1]), note: 'netstat -ano' };
  }
  return { pid: null, note: 'netstat 输出中未找到对应监听行，PID 记为 unknown' };
}

async function checkPort() {
  const name = 'port-19387';
  const extra = { port: null, listenerPid: null, pidEvidence: 'unknown', watchdogState: null };
  const cfg = readJson(join(stateDir, 'config.json'));
  if (!cfg.present) {
    return { name, ok: false, status: 'fail', ...extra, serviceState: 'not_installed',
      detail: '未发现 .local/config.json，服务尚未安装（缺 port 与本机凭据），因此无法探测端口。',
      fix: '先生成配置：在项目根目录执行 node src/cli.js setup（或双击 start.bat 由安装流程生成），再运行本诊断。' };
  }
  if (cfg.error || !cfg.value || !Number.isInteger(cfg.value.port) || typeof cfg.value.agentToken !== 'string' || !cfg.value.agentToken) {
    return { name, ok: null, status: 'unknown', ...extra, serviceState: null,
      detail: `.local/config.json 存在但无法读取有效的 port / 凭据（${sanitize(cfg.error || '字段缺失或格式不正确')}），无法判定服务状态；按约定报 unknown，不误判为失败。`,
      fix: '' };
  }
  const port = cfg.value.port;
  extra.port = port;
  const token = cfg.value.agentToken; // 仅用于请求头，绝不写入任何输出 / 日志 / 命令行
  const wd = readJson(join(stateDir, 'watchdog-status.json'));
  extra.watchdogState = (wd.value && typeof wd.value.state === 'string') ? wd.value.state : null;
  const watchdogText = extra.watchdogState ? `守护状态记录为 ${sanitize(extra.watchdogState)}，可作为旁证（不代表当前一定在跑）。` : '';

  const listening = await probePort(port);
  if (!listening) {
    return { name, ok: false, status: 'fail', ...extra, serviceState: 'not_running',
      detail: `端口 127.0.0.1:${port} 没有监听者，服务未启动。${watchdogText}`,
      fix: '双击 start.bat 启动服务；若窗口一闪而过，先确认上方 pwsh-7 / node-22 是否通过。也可在项目根目录执行 node src/server.js 前台启动观察报错，再重新运行本诊断。' };
  }
  const pidInfo = listenerPid(port);
  extra.listenerPid = pidInfo.pid;
  extra.pidEvidence = pidInfo.pid === null ? 'unknown' : 'netstat';
  const pidText = pidInfo.pid === null ? '监听 PID 未能解析（unknown，未伪造）。' : `监听 PID=${pidInfo.pid}（netstat -ano）。`;
  const st = await fetchStatus(port, token);
  if (st.reachable) {
    return { name, ok: true, status: 'ok', ...extra, serviceState: 'running',
      detail: `端口 127.0.0.1:${port} 有监听，带本地凭据的 /status 校验通过（服务正常应答）。${pidText}${watchdogText}`,
      fix: '' };
  }
  const reason = st.error ? sanitize(st.error) : `应答服务标识=${sanitize(st.bodyService ?? 'none')}`;
  return { name, ok: false, status: 'fail', ...extra, serviceState: 'port_occupied_or_unresponsive',
    detail: `端口 127.0.0.1:${port} 有监听，但带本地凭据的 /status 未通过（HTTP ${st.httpStatus ?? 'n/a'}；${reason}）。可能是别的程序占用了端口、服务异常或本机请求被代理干扰。${pidText}${watchdogText}`,
    fix: `端口被占用或服务无响应。排查命令：netstat -ano | findstr :${port} 查占用 PID；用 tasklist /fi "PID eq <PID>" 确认进程归属；确认 NO_PROXY 覆盖 127.0.0.1；必要时在项目根目录执行 node src/server.js 观察启动报错。不要在未确认归属前结束不明进程。` };
}

function checkNoProxy() {
  const name = 'no-proxy-loopback';
  const raw = [process.env.NO_PROXY, process.env.no_proxy].filter(Boolean).join(',');
  const entries = raw.split(/[,;\s]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
  const norm = s => {
    let v = s.replace(/^\./, '').toLowerCase();
    if (/^[^:]+:\d+$/.test(v)) v = v.replace(/:\d+$/, '');
    else if (/^[^:]+:\*$/.test(v)) v = v.replace(/:\*$/, '');
    return v;
  };
  const covers = t => entries.some(e => e === '*' || norm(e) === t);
  const targets = ['127.0.0.1', 'localhost', '::1'];
  const missing = targets.filter(t => !covers(t));
  const proxyVars = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy'].filter(k => process.env[k]);
  const ok = missing.length === 0;
  return { name, ok, status: ok ? 'ok' : 'fail',
    detail: ok
      ? `NO_PROXY / no_proxy 已覆盖 127.0.0.1、localhost、::1（当前值：${sanitize(raw) || '(空)'}）。${proxyVars.length ? `检测到代理变量 ${proxyVars.join('、')}，本机请求已明确绕过代理。` : '未检测到会话级代理变量。'}`
      : `NO_PROXY / no_proxy 未完整覆盖本机回环地址，缺少 ${missing.join('、')}（当前值：${sanitize(raw) || '(空)'}）。${proxyVars.length ? `检测到代理变量 ${proxyVars.join('、')}，本机 127.0.0.1 请求有被代理吞掉的风险。` : ''}`,
    fix: ok ? ''
      : '为本机回环地址固化免代理（在「命令提示符」执行，重开终端生效）：setx NO_PROXY "127.0.0.1,localhost,::1"；若已有用户级 no_proxy，建议同步设置同名值。不要让本机请求走系统代理。',
    noProxy: sanitize(raw), missingTargets: missing, proxyVariablesPresent: proxyVars };
}

const runtime = readJson(join(stateDir, 'runtime.json'));
const checks = [
  checkPwsh(),
  checkNode(runtime),
  checkRuntime(runtime),
  checkAutostart(),
  await checkPort(),
  checkNoProxy()
];
const failed = checks.filter(c => c.ok === false);
const unknown = checks.filter(c => c.ok === null);
const ok = failed.length === 0; // unknown 项不算失败
const exitCode = ok ? 0 : 1;
const note = '本诊断入口由 node.exe 直接运行 scripts/doctor-host-env.mjs，完全不经过 pwsh.exe，因此在未安装 PowerShell 7 的机器上也能运行，可覆盖「doctor.bat 因缺 pwsh 而打不开」这一盲区。';
const report = {
  service: 'ai-browser-bridge', tool: 'doctor-host-env', generatedAt: new Date().toISOString(),
  note, ok, exitCode,
  passedCount: checks.filter(c => c.ok === true).length,
  failedCount: failed.length, unknownCount: unknown.length,
  checks
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const lines = [];
  lines.push('============================================================');
  lines.push(' AI Browser Bridge · 宿主环境诊断（doctor-lite）');
  lines.push(` 生成时间：${report.generatedAt}`);
  lines.push('');
  lines.push(` 说明：${note}`);
  lines.push('');
  lines.push('------------------------------------------------------------');
  for (const c of checks) {
    const tag = c.ok === true ? '[通过]' : c.ok === false ? '[失败]' : '[未知]';
    lines.push(`${tag} ${c.name}`);
    lines.push(`  ${c.detail}`);
    if (c.ok === false && c.fix) lines.push(`  修复：${c.fix}`);
    lines.push('');
  }
  lines.push('------------------------------------------------------------');
  lines.push(` 汇总：通过 ${report.passedCount} / 失败 ${report.failedCount} / 未知 ${report.unknownCount}`);
  lines.push(` 整体结论：${report.ok ? '未发现明确失败项（unknown 项仅表示查不到，不算失败）' : '存在明确失败项，请按上方「修复」处理'}`);
  lines.push(` 退出码：${report.exitCode}`);
  lines.push(' 提示：双击 doctor-lite.bat 无需 PowerShell 7；追加 --json 可输出结构化结果供脚本使用。');
  lines.push('============================================================');
  console.log(lines.join('\n'));
}
process.exitCode = exitCode;
