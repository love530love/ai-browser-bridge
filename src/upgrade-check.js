// Pure decision layer for "git pull is not the same as upgrade complete".
//
// buildUpgradeCheck() never reads files, never talks to the service, never
// restarts anything and never writes config. The CLI collects the facts and
// hands them in; this module only turns those facts into an ordered list of
// copyable steps. Keeping it side-effect free is what makes the whole "one
// command gives an ordered, copyable plan" testable without a live bridge.

// A missing config field is one that loadConfig() would silently default at
// read time. Writing it back explicitly is a migration, not a behaviour change:
// the one-liner preserves every other key (including the pairing tokens, which
// it never prints) and keeps the 0600 mode.
function configFieldCommand(field, defaultValue) {
  const literal = JSON.stringify(defaultValue);
  return `node -e "const fs=require('fs');const p='.local/config.json';const c=JSON.parse(fs.readFileSync(p,'utf8'));if(!('${field}' in c))c.${field}=${literal};fs.writeFileSync(p,JSON.stringify(c,null,2),{mode:0o600});console.log('wrote ${field}')"`;
}

const CONFIG_FIELD_FIX = {
  browserTarget: () => ({
    command: 'node src/cli.js set-browser-target --from-running-chrome',
    note: '先 dry-run 看建议与证据；确认与当前正在用的 Chrome 一致后，追加 --write 才写回 config.json。'
  }),
  uploadRoots: defaults => ({
    command: configFieldCommand('uploadRoots', defaults?.uploadRoots ?? []),
    note: 'loadConfig() 已提供空数组默认值；此命令把该默认值显式写回 config.json，保留其它字段与密钥。'
  }),
  uploadMaxBytes: defaults => ({
    command: configFieldCommand('uploadMaxBytes', defaults?.uploadMaxBytes ?? 16 * 1024 * 1024),
    note: 'loadConfig() 已提供默认上限（16 MiB）；此命令把该默认值显式写回 config.json，保留其它字段与密钥。'
  })
};

// NEVER emit a copyable command that kills `.local/server.pid`. That file is
// NOT proof of process identity: measured on this machine, it pointed at a dead
// PID while a different node process (started with a relative `src/server.js`)
// owned port 19387. A blind SIGTERM would kill nothing, or kill an unrelated
// process. Only the heartbeat allow-list restarts a service, and only after an
// idle / cooldown / single-instance-lock / recheck gate.
// Read-only evidence gathering only: /status proves the service answers and is
// idle, netstat exposes the PID that actually owns 19387 (LISTENING). The user
// compares that PID with .local/server.pid and the process command line before
// any restart is delegated to the watchdog - see the step note. No kill here.
const RESTART_COMMAND = 'node src/cli.js status && netstat -ano -p TCP | findstr 19387';
const RELOAD_COMMAND = "node src/cli.js call browser_reload_extension '{\"confirmation\":\"reload_extension_once\",\"allowFocus\":true}'";
const VERIFY_COMMAND = 'doctor-lite.bat && doctor.bat';

export function buildUpgradeCheck({ disk = {}, running = null, config = {}, git = {}, extensionId = null } = {}) {
  const missingFields = Array.isArray(config.missingFields) ? config.missingFields : [];
  const reachable = running !== null && running !== undefined;
  const diskVersion = disk.version ?? null;
  const diskManifestVersion = disk.manifestVersion ?? null;
  const diskBuildId = disk.buildId ?? null;

  const steps = [];
  let order = 0;
  const push = (layer, problem, command, note) => {
    steps.push({ order: ++order, layer, problem, command, note });
  };

  // 1. The four version markers must come from one release. package.json and
  //    extension/manifest.json disagreeing is a working-tree/release problem,
  //    not something an operator should fix by hand-editing version files.
  const versionSyncOk = diskVersion === diskManifestVersion;
  if (!versionSyncOk) {
    push('version-sync', '四处版本未同步：package.json 与 extension/manifest.json 版本号不一致',
      'git status --short -- package.json extension/manifest.json',
      '四处版本（两处工程版本标记与两处功能叙述标记）须随同一发布提交一致；确认工作区无未提交的版本改动，必要时 git pull --ff-only origin main 重新同步，不要手改版本号。');
  }

  // 2. Service layer. A null running means /status never answered; a buildId
  //    mismatch means the process is still executing the pre-pull source.
  if (!reachable) {
    push('service', '服务不可达（running=null）：/status 无应答',
      'start.bat && doctor-lite.bat',
      '先运行 start.bat 启动服务；若启动器本身失败（缺 PowerShell 7、端口占用、代理吞掉 loopback），doctor-lite.bat 用纯 node 定位；完成后运行 node src/cli.js status 确认应答。');
  } else if (running.buildId !== diskBuildId) {
    push('service', '服务仍跑旧源码（running.buildId 与磁盘 buildId 不一致）',
      RESTART_COMMAND,
      '先只读复核，不要杀任何进程：确认 netstat -ano -p TCP 里 19387 的 LISTENING PID 与 .local/server.pid 一致、该进程命令行确实指向本项目 src/server.js、且 /status 显示完全空闲（queued=0、无 in-flight）。任一不符或无法确认时只报告证据、绝不终止不明进程——server.pid 不是进程存活证据。确认一致后在空闲窗口交给看门狗拉起新源码（约 10 秒），或启用 install-autostart.ps1 -Heartbeat 让心跳白名单动作处理；随后 node src/cli.js status 核对 buildId。绝对不要用 stop.ps1（它会写 service-paused 让守护自我暂停）。');
  }

  // 3. Extension layer. Only meaningful while the service answers; a connected
  //    extension self-reloads, multiple hosts are reloaded per hostId.
  if (reachable && running.extensionVersion !== diskManifestVersion) {
    push('extension', '扩展落后（running.extensionVersion 与 manifest.json 版本不一致）',
      RELOAD_COMMAND,
      '扩展已连接时会走 chrome.runtime.reload() 自我重载；多宿主部署按各 hostId 分别调用一次，逐个确认版本后再继续。');
  }

  // 4. Config migration. One step per missing field, each with a copyable fix.
  for (const field of missingFields) {
    const fix = (CONFIG_FIELD_FIX[field] ?? (() => ({
      command: configFieldCommand(field, null),
      note: '把该字段显式写回 config.json（保留其它字段与密钥）；如字段来自新版本，请按 CHANGELOG 的字段说明填值。'
    })))(config.defaults);
    push('config', `配置缺字段：${field}`, fix.command, fix.note);
  }

  // 5. Always last: proof, not a claim. Nothing above is considered done until
  //    both doctors agree.
  push('verify', '全部步骤执行完毕后复验', VERIFY_COMMAND,
    '先 doctor-lite.bat 再 doctor.bat；期望 doctor.ok=true，且 running.buildId===disk.buildId、version-match 全绿。');

  const problemCount = steps.filter(step => step.layer !== 'verify').length;
  const ok = problemCount === 0;

  const layers = {
    'version-sync': {
      ok: versionSyncOk,
      diskVersion,
      manifestVersion: diskManifestVersion
    },
    service: {
      ok: reachable && running.buildId === diskBuildId,
      reachable,
      runningBuildId: reachable ? running.buildId ?? null : null,
      diskBuildId,
      buildIdCurrent: reachable ? running.buildId === diskBuildId : null
    },
    extension: {
      ok: reachable ? running.extensionVersion === diskManifestVersion : null,
      runningExtensionVersion: reachable ? running.extensionVersion ?? null : null,
      manifestVersion: diskManifestVersion,
      versionCurrent: reachable ? running.extensionVersion === diskManifestVersion : null
    },
    config: {
      ok: missingFields.length === 0,
      missingFields
    },
    git: { ok: true, ...git },
    extensionId
  };

  return { ok, layers, steps };
}
