import { mkdir, writeFile, readFile, rename, unlink } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { randomBytes, scrypt as scryptCallback } from 'node:crypto';
import { promisify } from 'node:util';
import { execFile as execFileCallback } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { isEntryPoint, resolveSettings } from './server.mjs';
import { findOnPath, resolveCodexExe } from './bridge/app-server.mjs';

const scrypt = promisify(scryptCallback);
const execFile = promisify(execFileCallback);
export const ACCESS_FILE = 'CodexRemoteWeb-access.txt';

function isDirectory(target) { try { return statSync(target).isDirectory(); } catch { return false; } }

// Machine-specific values of a new runtime config. codexExe and cloudflaredPath stay empty: the server finds Codex
// itself (desktop app copy, then PATH) and start.ps1 finds cloudflared on PATH. allowedRoots is left for the user;
// resumeRoots starts with the Codex desktop app's default work folder when it exists.
export function runtimeDefaults({ env = process.env, isDir = isDirectory } = {}) {
  const userProfile = env.USERPROFILE || os.homedir();
  const codexHome = env.CODEX_HOME || path.join(userProfile, '.codex');
  const desktopWork = path.join(userProfile, 'Documents', 'Codex');
  return {
    bindHost: '127.0.0.1', port: 47831, publicOrigin: 'https://replace-after-tunnel.invalid',
    allowedRoots: [], resumeRoots: isDir(desktopWork) ? [desktopWork] : [], transport: 'stdio',
    codexExe: '', codexHome, userProfile, cloudflaredPath: ''
  };
}

// Same places start.ps1 looks: PATH, then the folders the Cloudflare installer (winget) uses.
export function findCloudflared({ env = process.env } = {}) {
  const onPath = findOnPath('cloudflared', { env });
  if (onPath) return onPath;
  for (const base of [env['ProgramFiles(x86)'], env.ProgramFiles]) {
    if (!base) continue;
    const candidate = path.join(base, 'cloudflared', 'cloudflared.exe');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

// Windows tools by absolute path, so nothing named whoami/icacls in the current folder or on PATH can stand in.
function systemTool(name) { return path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', name); }

// ACL principal for the current user. The SID form (*S-1-5-...) is used because a bare account name is ambiguous
// when it equals the computer name: icacls then grants the machine instead of the user and locks the user out.
async function currentAccount() {
  try {
    const { stdout } = await execFile(systemTool('whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { windowsHide: true });
    const sid = stdout.trim().split(',').pop().replace(/"/g, '').trim();
    if (/^S-1-\d+(-\d+)+$/.test(sid)) return `*${sid}`;
  } catch { /* fall back to the account name */ }
  const name = process.env.USERNAME;
  return name ? (process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${name}` : name) : null;
}

async function main() {
  // configPath is always <dataDir>\runtime-config.json: the config lives in the folder this script locks down.
  const { dataDir, outputDir, configPath } = resolveSettings();
  const outputPath = path.join(outputDir, ACCESS_FILE);
  const account = await currentAccount();
  async function secure(target, inheritance) {
    if (!account) throw new Error('Current Windows account is unavailable for ACL setup');
    const grants = inheritance ? [`${account}:(OI)(CI)(F)`, '*S-1-5-18:(OI)(CI)(F)', '*S-1-5-32-544:(OI)(CI)(F)'] : [`${account}:(F)`, '*S-1-5-18:(F)', '*S-1-5-32-544:(F)'];
    await execFile(systemTool('icacls.exe'), [target, '/inheritance:r', '/grant:r', ...grants], { windowsHide: true });
  }

  try { await readFile(configPath); throw new Error(`Refusing to overwrite existing runtime config: ${configPath}`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { await readFile(outputPath); throw new Error(`Refusing to overwrite existing access password file: ${outputPath}`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const password = randomBytes(24).toString('base64url');
  const salt = randomBytes(16); const hash = await scrypt(password, salt, 32);
  await mkdir(dataDir, { recursive: true }); await secure(dataDir, true); await mkdir(outputDir, { recursive: true });
  const config = {
    ...runtimeDefaults(),
    password: { algorithm: 'scrypt', salt: salt.toString('base64url'), hash: hash.toString('base64url') },
    sessionKey: randomBytes(32).toString('base64url')
  };
  const temp = `${configPath}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 }); await rename(temp, configPath);
  await writeFile(outputPath, `Codex Remote Web access password\n\n${password}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    for (const target of [configPath, outputPath]) await secure(target, false);
  } catch (error) {
    await Promise.allSettled([unlink(configPath), unlink(outputPath)]);
    throw new Error(`Could not secure runtime files: ${error.message}`);
  }

  // The password itself is never printed; only where it is.
  const codex = resolveCodexExe('');
  const cloudflared = findCloudflared();
  const lines = [
    `Runtime config: ${configPath}`,
    `Access password file: ${outputPath}`,
    '',
    'Next steps:',
    '  1. Edit the runtime config above:',
    '     - "allowedRoots": folders whose direct subfolders are your projects, e.g. ["C:\\\\Users\\\\<you>\\\\Projects"].',
    '       New tasks can only start there; with an empty list the panel can open existing tasks only.',
    `     - "resumeRoots": folders whose desktop-started tasks may be resumed from the web. Now: ${config.resumeRoots.length ? config.resumeRoots.join(', ') : '(empty)'}`,
    `  2. Codex: ${codex.source === 'none' ? 'codex.exe NOT found. Install/sign in to the Codex desktop app or CLI, or set "codexExe".' : `${codex.command} (found automatically; leave "codexExe" empty to keep auto-detection)`}`,
    `  3. cloudflared: ${cloudflared ? `${cloudflared} (found; leave "cloudflaredPath" empty)` : 'NOT found. Install it (winget install --id Cloudflare.cloudflared) or set "cloudflaredPath".'}`,
    '  4. Check everything without starting: powershell -ExecutionPolicy Bypass -File .\\start.ps1 -CheckOnly',
    ''
  ];
  process.stdout.write(lines.join('\n'));
}

if (isEntryPoint(import.meta.url)) main().catch(error => { process.stderr.write(`Setup failed: ${error.message}\n`); process.exitCode = 1; });
