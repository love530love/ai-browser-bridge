// Pure text for the panel. Kept out of panel.js so the exact wording can be
// asserted in Node without a DOM or a live Chrome.
export function deploymentHint(deployment, { connected = true } = {}) {
  if (!connected || !deployment || deployment.upgradeRequired !== true) return null;
  const parts = [];
  if (deployment.deploymentStale === true) {
    const running = String(deployment.runningBuildId ?? 'unknown').slice(0, 12);
    const disk = String(deployment.diskBuildId ?? 'unknown').slice(0, 12);
    parts.push(`服务仍在运行旧源码（${running} ≠ ${disk}）。空闲时执行 node src/cli.js restart-service-when-idle --apply`);
  }
  if (deployment.extensionVersionSkew === true) {
    parts.push(`扩展 ${deployment.extensionVersion ?? '?'} 与磁盘 ${deployment.manifestVersion ?? '?'} 不一致：在 chrome://extensions 重载扩展，或运行 upgrade-check 给出的重载命令。`);
  }
  const missing = Array.isArray(deployment.configMissingFields) ? deployment.configMissingFields : [];
  if (missing.length > 0) {
    parts.push(`配置缺字段：${missing.join('、')}。运行 node src/cli.js upgrade-check 获取保留密钥的写回命令。`);
  }
  return parts.length > 0 ? parts.join(' ') : null;
}
