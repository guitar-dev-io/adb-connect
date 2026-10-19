'use strict';
const { spawn } = require('node:child_process');
const net = require('node:net');

function validEndpoint(value) {
  const s = String(value || '').trim();
  // Explicit IPv4 or bracketed IPv6 + port, or safe local DNS host name + port.
  const m = s.match(/^(\[[0-9a-fA-F:.%]+\]|[A-Za-z0-9.-]+):(\d{1,5})$/);
  if (!m) return false;
  const port = Number(m[2]);
  const host = m[1];
  return port >= 1 && port <= 65535 && (host.startsWith('[') || net.isIP(host) === 4 || /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(host));
}
function runAdb(path, args, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    let done = false;
    const cp = spawn(path || 'adb', args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const finish = (error, result) => { if (done) return; done = true; clearTimeout(timer); error ? reject(error) : resolve(result); };
    const timer = setTimeout(() => { cp.kill(); finish(new Error('ADB timed out')); }, timeoutMs);
    cp.stdout.on('data', b => { out = (out + b.toString()).slice(-100000); });
    cp.stderr.on('data', b => { err = (err + b.toString()).slice(-100000); });
    cp.on('error', e => finish(new Error(`Cannot run ADB (${path}): ${e.message}`)));
    cp.on('close', code => finish(null, { code, stdout: out, stderr: err, text: `${out}\n${err}`.trim() }));
  });
}
function parseDevices(text) {
  return String(text).split(/\r?\n/).slice(1).filter(Boolean).map(line => {
    const m = line.match(/^(\S+)\s+(device|offline|unauthorized|recovery|sideload|bootloader|no permissions)(?:\s+(.*))?$/);
    if (!m) return null;
    const attrs = {};
    for (const token of (m[3] || '').split(/\s+/)) {
      const p = token.indexOf(':'); if (p > 0) attrs[token.slice(0,p)] = token.slice(p+1);
    }
    return { serial:m[1], status:m[2], model: attrs.model || attrs.device || m[1], transport: m[1].includes(':') ? 'Wi-Fi' : 'USB' };
  }).filter(Boolean);
}
function parseMdns(text) {
  return String(text).split(/\r?\n/).map(line => {
    const m = line.match(/^(.*?)\s+(_adb-tls-(?:connect|pairing)\._tcp)\.?\s+([^\s]+:\d+)\s*$/);
    return m && validEndpoint(m[3]) ? { service:m[2], name:m[1].trim(), endpoint:m[3] } : null;
  }).filter(Boolean);
}
module.exports = { runAdb, parseDevices, parseMdns, validEndpoint };
