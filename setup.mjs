import { mkdir, writeFile, readFile, rename, unlink } from 'node:fs/promises';
import { randomBytes, scrypt as scryptCallback } from 'node:crypto';
import { promisify } from 'node:util';
import { execFile as execFileCallback } from 'node:child_process';
import path from 'node:path';

const scrypt = promisify(scryptCallback);
const execFile = promisify(execFileCallback);
const dataDir = process.env.CODEX_REMOTE_DATA_DIR || 'C:\\Codex\\Apps\\CodexRemoteWeb\\data';
const outputPath = 'C:\\Codex\\2026-09-22\\new-chat\\outputs\\CodexRemoteWeb-access.txt';
const configPath = path.join(dataDir, 'runtime-config.json');
const account = process.env.USERNAME;
async function secure(target, inheritance) {
  if (!account) throw new Error('Current Windows account is unavailable for ACL setup');
  const grants = inheritance ? [`${account}:(OI)(CI)(F)`, '*S-1-5-18:(OI)(CI)(F)', '*S-1-5-32-544:(OI)(CI)(F)'] : [`${account}:(F)`, '*S-1-5-18:(F)', '*S-1-5-32-544:(F)'];
  await execFile('icacls', [target, '/inheritance:r', '/grant:r', ...grants], { windowsHide: true });
}

try { await readFile(configPath); throw new Error(`Refusing to overwrite existing runtime config: ${configPath}`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
try { await readFile(outputPath); throw new Error(`Refusing to overwrite existing access password file: ${outputPath}`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const password = randomBytes(24).toString('base64url');
const salt = randomBytes(16); const hash = await scrypt(password, salt, 32);
await mkdir(dataDir, { recursive: true }); await secure(dataDir, true); await mkdir(path.dirname(outputPath), { recursive: true });
const config = {
  bindHost: '127.0.0.1', port: 47831, publicOrigin: 'https://replace-after-tunnel.invalid',
  allowedRoots: ['C:\\Codex\\Projects'], transport: 'stdio',
  codexExe: '', codexHome: '', userProfile: '', cloudflaredPath: '',
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
process.stdout.write(`Runtime config: ${configPath}\nAccess password file: ${outputPath}\n`);
