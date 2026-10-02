// Per-machine path resolution (server.mjs resolveSettings, start.ps1), Codex executable discovery
// (bridge/app-server.mjs), and the values setup.mjs writes. Everything runs in fresh temp folders with injected
// environments: the repository's own local.settings.json, the real data folder and the real ~/.codex are never used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile, utimes, rm, realpath, symlink, copyFile, link } from 'node:fs/promises';
import { resolveSettings, runtimeConfigPath, isEntryPoint } from '../server.mjs';
import { AppServer, resolveCodexExe, desktopCodexCandidates, findOnPath } from '../bridge/app-server.mjs';
import { runtimeDefaults } from '../setup.mjs';

const execFile = promisify(execFileCallback);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const windowsOnly = process.platform !== 'win32' && 'Windows paths and tools';
const noFile = () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); };
const fileText = text => () => text;

async function tempDir(t, prefix) {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function touch(file, when) {
  await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, 'stand-in');
  if (when) await utimes(file, when, when);
  return file;
}
// Environment for child processes: the caller's, minus every variable that could point at real panel or Codex state.
// Windows variable names are case-insensitive, so an override replaces any spelling (Path/PATH).
function cleanEnv(extra) {
  const overridden = new Set(Object.keys(extra).map(key => key.toUpperCase()));
  const env = {};
  for (const [key, value] of Object.entries(process.env)) if (!/^(CODEX_REMOTE_|CODEX_HOME$)/i.test(key) && !overridden.has(key.toUpperCase())) env[key] = value;
  return { ...env, ...extra };
}

test('settings: portable defaults when nothing is configured', { skip: windowsOnly }, () => {
  const r = resolveSettings({ env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, root: 'C:\\repo', readText: noFile });
  assert.equal(r.settingsFile, 'C:\\repo\\local.settings.json');
  assert.equal(r.settingsFound, false);
  assert.equal(r.dataDir, 'C:\\Users\\u\\AppData\\Local\\CodexRemoteWeb\\data'); assert.equal(r.dataDirSource, 'default');
  assert.equal(r.outputDir, r.dataDir, 'password and URL files default to the setup-secured data folder'); assert.equal(r.outputDirSource, 'default');
  assert.equal(r.configPath, 'C:\\Users\\u\\AppData\\Local\\CodexRemoteWeb\\data\\runtime-config.json');
  const noLocalAppData = resolveSettings({ env: { USERPROFILE: 'C:\\Users\\u' }, root: 'C:\\repo', readText: noFile });
  assert.equal(noLocalAppData.dataDir, 'C:\\Users\\u\\AppData\\Local\\CodexRemoteWeb\\data');
});

test('settings: local.settings.json beats defaults, environment beats local.settings.json, per value', { skip: windowsOnly }, () => {
  const local = JSON.stringify({ dataDir: 'D:\\panel\\data', outputDir: 'D:\\panel\\out', nodeExe: 'D:\\node\\node.exe', unknown: 1 });
  const env = { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' };
  let r = resolveSettings({ env, root: 'C:\\repo', readText: fileText(local) });
  assert.equal(r.settingsFound, true);
  assert.deepEqual([r.dataDir, r.dataDirSource, r.outputDir, r.outputDirSource], ['D:\\panel\\data', 'local.settings.json', 'D:\\panel\\out', 'local.settings.json']);
  assert.equal(r.configPath, 'D:\\panel\\data\\runtime-config.json');
  r = resolveSettings({ env: { ...env, CODEX_REMOTE_DATA_DIR: 'E:\\env\\data' }, root: 'C:\\repo', readText: fileText(local) });
  assert.deepEqual([r.dataDir, r.dataDirSource, r.outputDir, r.outputDirSource], ['E:\\env\\data', 'env:CODEX_REMOTE_DATA_DIR', 'D:\\panel\\out', 'local.settings.json']);
  r = resolveSettings({ env: { ...env, CODEX_REMOTE_OUTPUT_DIR: 'E:\\env\\out', CODEX_REMOTE_NODE_EXE: 'E:\\node.exe', CODEX_REMOTE_CONFIG: 'F:\\exact\\config.json' }, root: 'C:\\repo', readText: fileText(local) });
  assert.deepEqual([r.dataDir, r.outputDir, r.outputDirSource, r.nodeExe, r.nodeExeSource], ['D:\\panel\\data', 'E:\\env\\out', 'env:CODEX_REMOTE_OUTPUT_DIR', 'E:\\node.exe', 'env:CODEX_REMOTE_NODE_EXE']);
  assert.equal(r.configPath, 'D:\\panel\\data\\runtime-config.json', 'setup always writes the config into the secured data folder; CODEX_REMOTE_CONFIG is not a setting');
  // Only dataDir set: the password/URL files follow it. Empty strings, blank env values and a BOM mean "not set".
  r = resolveSettings({ env: { ...env, CODEX_REMOTE_DATA_DIR: '  ' }, root: 'C:\\repo', readText: fileText(`\uFEFF${JSON.stringify({ dataDir: 'D:\\only\\data', outputDir: '' })}`) });
  assert.deepEqual([r.dataDir, r.outputDir, r.outputDirSource], ['D:\\only\\data', 'D:\\only\\data', 'default']);
});

test('settings: CODEX_REMOTE_SETTINGS picks the file; broken settings stop instead of falling back', { skip: windowsOnly }, () => {
  const seen = [];
  resolveSettings({ env: { LOCALAPPDATA: 'C:\\L', CODEX_REMOTE_SETTINGS: 'D:\\elsewhere\\s.json' }, root: 'C:\\repo', readText: file => { seen.push(file); return noFile(); } });
  assert.deepEqual(seen, ['D:\\elsewhere\\s.json']);
  const run = text => () => resolveSettings({ env: { LOCALAPPDATA: 'C:\\L' }, root: 'C:\\repo', readText: fileText(text) });
  assert.throws(run('{ not json'), /not valid JSON/);
  assert.throws(run('["C:\\\\x"]'), /JSON object/);
  assert.throws(run(JSON.stringify({ dataDir: 'relative\\data' })), /absolute path/);
  assert.throws(run(JSON.stringify({ dataDir: 'C:rel\\data' })), /absolute path/, 'drive-relative paths depend on the current folder of that drive');
  assert.throws(run(JSON.stringify({ dataDir: '\\rooted\\data' })), /absolute path/, 'root-relative paths depend on the current drive');
  for (const value of [42, true, [], ['C:\\x'], {}]) assert.throws(run(JSON.stringify({ outputDir: value })), /outputDir in .* must be a string/, JSON.stringify(value));
  assert.throws(run(JSON.stringify({ nodeExe: 5 })), /nodeExe in .* must be a string/);
  assert.throws(run(JSON.stringify({ dataDir: 'C:\\a', DataDir: 'C:\\b' })), /not valid JSON/, 'keys differing only in case: PowerShell 5.1 cannot load such a file either');
  assert.throws(() => resolveSettings({ env: { LOCALAPPDATA: 'C:\\L', CODEX_REMOTE_DATA_DIR: 'data' }, root: 'C:\\repo', readText: noFile }), /absolute path/);
  assert.throws(() => resolveSettings({ env: { LOCALAPPDATA: 'C:\\L' }, root: 'C:\\repo', readText: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } }), /Cannot read/);
  assert.throws(() => resolveSettings({ env: { LOCALAPPDATA: 'C:\\L' }, root: 'C:\\repo', readText: () => { throw Object.assign(new Error('EISDIR: illegal operation'), { code: 'EISDIR' }); } }), /Cannot read C:\\repo\\local\.settings\.json: it is a folder/);
  // Accepted: forward-slash drive paths and UNC; case-sensitive keys (DataDir is not dataDir); null means "not set".
  assert.equal(resolveSettings({ env: { LOCALAPPDATA: 'C:\\L' }, root: 'C:\\repo', readText: fileText(JSON.stringify({ dataDir: 'C:/x/data' })) }).dataDir, 'C:/x/data');
  assert.equal(resolveSettings({ env: { LOCALAPPDATA: 'C:\\L' }, root: 'C:\\repo', readText: fileText(JSON.stringify({ dataDir: '\\\\server\\share\\data' })) }).dataDir, '\\\\server\\share\\data');
  assert.equal(resolveSettings({ env: { LOCALAPPDATA: 'C:\\L' }, root: 'C:\\repo', readText: fileText(JSON.stringify({ DataDir: 'D:\\x' })) }).dataDirSource, 'default');
  assert.equal(resolveSettings({ env: { LOCALAPPDATA: 'C:\\L' }, root: 'C:\\repo', readText: fileText(JSON.stringify({ dataDir: null, outputDir: '  ' })) }).outputDirSource, 'default');
});

test('settings: server.mjs takes the exact config from start.ps1 without consulting the settings file', { skip: windowsOnly }, () => {
  const broken = () => { throw new Error('settings file must not be read'); };
  assert.equal(runtimeConfigPath({ env: { CODEX_REMOTE_CONFIG: ' D:\\data\\runtime-config.json ' }, readText: broken }), 'D:\\data\\runtime-config.json');
  assert.equal(runtimeConfigPath({ env: { CODEX_REMOTE_CONFIG: 'D:\\data\\runtime-config.json' }, readText: fileText('{"outputDir": 42}') }), 'D:\\data\\runtime-config.json', 'a value the server does not use cannot stop it');
  assert.equal(runtimeConfigPath({ env: { LOCALAPPDATA: 'C:\\L' }, root: 'C:\\repo', readText: noFile }), 'C:\\L\\CodexRemoteWeb\\data\\runtime-config.json');
});

test('entry point check follows junctions (node reports the main module by its real path)', { skip: windowsOnly }, async t => {
  const base = await tempDir(t, 'crw-entry-');
  const link = path.join(base, 'repo-link');
  await symlink(repo, link, 'junction');
  assert.equal(isEntryPoint(pathToFileURL(path.join(repo, 'server.mjs')).href, path.join(link, 'server.mjs')), true);
  assert.equal(isEntryPoint(pathToFileURL(path.join(repo, 'server.mjs')).href, path.join(repo, 'setup.mjs')), false);
  assert.equal(isEntryPoint(pathToFileURL(path.join(repo, 'server.mjs')).href, undefined), false);
});

test('settings: reads a real local.settings.json from the given repository root', { skip: windowsOnly }, async t => {
  const root = await tempDir(t, 'crw-settings-');
  await writeFile(path.join(root, 'local.settings.json'), JSON.stringify({ dataDir: path.join(root, 'data'), outputDir: path.join(root, 'out') }));
  const r = resolveSettings({ env: { LOCALAPPDATA: path.join(root, 'lad') }, root });
  assert.deepEqual([r.settingsFound, r.dataDir, r.outputDir], [true, path.join(root, 'data'), path.join(root, 'out')]);
});

test('codex: newest desktop-app copy wins, folders without codex.exe are skipped', { skip: windowsOnly }, async t => {
  const base = await tempDir(t, 'crw-codex-');
  const bin = path.join(base, 'lad', 'OpenAI', 'Codex', 'bin');
  const older = await touch(path.join(bin, 'ffff0000aaaa1111', 'codex.exe'), new Date('2026-01-01T00:00:00Z'));
  const newer = await touch(path.join(bin, '0000ffff2222bbbb', 'codex.exe'), new Date('2026-02-01T00:00:00Z'));
  await touch(path.join(bin, '1111222233334444', 'rg.exe'));
  const env = { LOCALAPPDATA: path.join(base, 'lad'), PATH: '' };
  assert.deepEqual(desktopCodexCandidates({ env }).map(c => c.path), [newer, older]);
  assert.deepEqual(resolveCodexExe('', { env, platform: 'win32' }), { command: newer, source: 'desktop', missing: null });
  assert.deepEqual(resolveCodexExe(older, { env, platform: 'win32' }), { command: older, source: 'config', missing: null }, 'an existing configured path is kept');
  const stale = path.join(bin, 'removed-by-update', 'codex.exe');
  assert.deepEqual(resolveCodexExe(stale, { env, platform: 'win32' }), { command: newer, source: 'desktop', missing: stale }, 'a path the updater removed falls back');
});

test('codex: PATH is used when there is no desktop-app copy; nothing found reports none', { skip: windowsOnly }, async t => {
  const base = await tempDir(t, 'crw-codexpath-');
  const tools = path.join(base, 'tools dir');
  const onPath = await touch(path.join(tools, 'codex.exe'));
  await touch(path.join(base, 'shim', 'codex.cmd'));
  const env = { LOCALAPPDATA: path.join(base, 'empty-lad'), Path: `${path.join(base, 'shim')};"${tools}"` };
  assert.equal(findOnPath('codex', { env, platform: 'win32' }), onPath, 'quoted PATH entries work; a .cmd shim is not an executable');
  assert.deepEqual(resolveCodexExe('', { env, platform: 'win32' }), { command: onPath, source: 'path', missing: null });
  assert.deepEqual(resolveCodexExe('codex', { env, platform: 'win32' }), { command: onPath, source: 'config', missing: null }, 'a bare configured name is looked up on PATH');
  const none = { LOCALAPPDATA: path.join(base, 'empty-lad'), PATH: path.join(base, 'shim') };
  assert.deepEqual(resolveCodexExe('', { env: none, platform: 'win32' }), { command: 'codex', source: 'none', missing: null });
  assert.deepEqual(resolveCodexExe('nosuch', { env: none, platform: 'win32' }), { command: 'nosuch', source: 'none', missing: 'nosuch' });
});

test('codex: relative PATH entries and relative configured paths are never used (no current-folder pickup)', () => {
  const everyFile = { statSync: () => ({ isFile: () => true }), readdirSync: () => { throw new Error('no desktop folder'); } };
  const env = { PATH: '.;bin;C:rel;\\rooted;"";D:\\tools' };
  assert.equal(findOnPath('codex', { env, platform: 'win32', fs: everyFile }), path.win32.join('D:\\tools', 'codex.exe'));
  assert.equal(findOnPath('codex', { env: { PATH: '.;bin' }, platform: 'win32', fs: everyFile }), null);
  const r = resolveCodexExe('bin\\codex.exe', { env: { PATH: '.' }, platform: 'win32', fs: everyFile });
  assert.deepEqual(r, { command: 'bin\\codex.exe', source: 'none', missing: 'bin\\codex.exe' });
});

function fakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.killed = false;
  child.kill = () => { child.killed = true; };
  child.stdin.on('data', data => {
    for (const line of String(data).split('\n').filter(Boolean)) {
      const message = JSON.parse(line);
      if (message.method === 'initialize') child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} })}\n`);
    }
  });
  return child;
}

test('bridge: connect spawns the resolved Codex and reports a stale configured path on stderr', { skip: windowsOnly }, async t => {
  const base = await tempDir(t, 'crw-bridge-');
  const newer = await touch(path.join(base, 'lad', 'OpenAI', 'Codex', 'bin', 'abc', 'codex.exe'));
  const env = { LOCALAPPDATA: path.join(base, 'lad'), PATH: '' };
  const stale = path.join(base, 'gone', 'codex.exe');
  const spawned = []; const warnings = [];
  const make = codexExe => new AppServer({ transport: 'stdio', codexExe }, {
    spawnImpl: (command, args) => { spawned.push({ command, args }); return fakeChild(); },
    resolveExe: value => resolveCodexExe(value, { env, platform: 'win32' }), warn: message => warnings.push(message)
  });
  const stalePanel = make(stale); await stalePanel.connect(); stalePanel.close();
  assert.deepEqual(spawned[0], { command: newer, args: ['app-server'] });
  assert.equal(warnings.length, 1); assert.match(warnings[0], /codexExe not found/); assert.ok(warnings[0].includes(stale) && warnings[0].includes(newer));
  const autoPanel = make(''); await autoPanel.connect(); autoPanel.close();
  assert.equal(spawned[1].command, newer); assert.equal(warnings.length, 1, 'auto-detection with an empty codexExe is silent');
  // Nothing found: a clear startup error instead of spawning a bare name from wherever the server runs.
  const nothing = new AppServer({ transport: 'stdio', codexExe: stale }, {
    spawnImpl: (command, args) => { spawned.push({ command, args }); return fakeChild(); },
    resolveExe: value => resolveCodexExe(value, { env: { LOCALAPPDATA: path.join(base, 'no-lad'), PATH: '' }, platform: 'win32' }), warn: message => warnings.push(message)
  });
  await assert.rejects(nothing.connect(), error => /codex\.exe not found/.test(error.message) && error.message.includes(stale) && /codexExe/.test(error.message));
  assert.equal(spawned.length, 2, 'nothing was spawned');
});

test('setup: runtime defaults point at the current user and leave paths to auto-detection', { skip: windowsOnly }, async t => {
  const home = await tempDir(t, 'crw-home-');
  let d = runtimeDefaults({ env: { USERPROFILE: home, CODEX_HOME: 'D:\\codex-home' } });
  assert.deepEqual({ ...d }, {
    bindHost: '127.0.0.1', port: 47831, publicOrigin: 'https://replace-after-tunnel.invalid', allowedRoots: [], resumeRoots: [], transport: 'stdio',
    codexExe: '', codexHome: 'D:\\codex-home', userProfile: home, cloudflaredPath: ''
  });
  await mkdir(path.join(home, 'Documents', 'Codex'), { recursive: true });
  d = runtimeDefaults({ env: { USERPROFILE: home } });
  assert.equal(d.codexHome, path.join(home, '.codex'));
  assert.deepEqual(d.resumeRoots, [path.join(home, 'Documents', 'Codex')], 'the desktop app work folder becomes a resume root when it exists');
});

test('setup: writes config and password file into the resolved data folder and never prints the password', { skip: windowsOnly, timeout: 60_000 }, async t => {
  const base = await tempDir(t, 'crw-setup-');
  const home = path.join(base, 'home'); await mkdir(path.join(home, 'Documents', 'Codex'), { recursive: true });
  const env = cleanEnv({ CODEX_REMOTE_SETTINGS: path.join(base, 'absent.settings.json'), CODEX_REMOTE_DATA_DIR: path.join(base, 'data'), USERPROFILE: home, LOCALAPPDATA: path.join(base, 'lad') });
  // Started through a junction to the repository: the entry-point check must still recognise setup.mjs.
  const link = path.join(base, 'repo-link'); await symlink(repo, link, 'junction');
  const first = await execFile(process.execPath, [path.join(link, 'setup.mjs')], { env, cwd: base, windowsHide: true });
  assert.match(first.stdout, /Runtime config: /, 'setup ran (it used to exit silently when started through a junction)');
  const config = JSON.parse(await readFile(path.join(base, 'data', 'runtime-config.json'), 'utf8'));
  assert.deepEqual([config.allowedRoots, config.resumeRoots, config.codexExe, config.cloudflaredPath], [[], [path.join(home, 'Documents', 'Codex')], '', '']);
  assert.deepEqual([config.codexHome, config.userProfile], [path.join(home, '.codex'), home]);
  assert.ok(config.password.salt && config.password.hash && config.sessionKey);
  const password = (await readFile(path.join(base, 'data', 'CodexRemoteWeb-access.txt'), 'utf8')).trim().split('\n').at(-1).trim();
  assert.ok(password.length >= 32);
  assert.ok(!first.stdout.includes(password) && !first.stderr.includes(password), 'password stays in the file only');
  assert.match(first.stdout, /allowedRoots/); assert.match(first.stdout, /-CheckOnly/);
  await assert.rejects(execFile(process.execPath, [path.join(repo, 'setup.mjs')], { env, cwd: repo, windowsHide: true }), error => /Refusing to overwrite/.test(error.stderr));
});

// Windows PowerShell writes redirected output in the console code page (949 on Korean Windows), so test commands switch
// it to UTF-8 first; paths travel in environment variables (UTF-16), never inside the command text.
const UTF8_OUTPUT = '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); ';
async function runPs(command, env, cwd = repo) {
  try {
    const { stdout, stderr } = await execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', UTF8_OUTPUT + command], { env, cwd, windowsHide: true, encoding: 'utf8' });
    return { code: 0, stdout, stderr };
  } catch (error) { return { code: error.code, stdout: error.stdout || '', stderr: error.stderr || '' }; }
}
// start.ps1 -CheckOnly [-DataDir x] [-OutputDir x] [-NodeExe x]; args like ['-DataDir', value].
async function checkOnly(env, args = [], script = path.join(repo, 'start.ps1'), cwd = path.dirname(script)) {
  const extra = {};
  for (let i = 0; i < args.length; i += 2) extra[`CRW_TEST_ARG_${args[i].replace(/^-/, '')}`] = args[i + 1];
  const command = "$p = @{ CheckOnly = $true }; foreach ($n in 'DataDir','OutputDir','NodeExe') { $v = [Environment]::GetEnvironmentVariable('CRW_TEST_ARG_' + $n); if ($v) { $p[$n] = $v } }; & $env:CRW_TEST_SCRIPT @p; exit $LASTEXITCODE";
  return runPs(command, { ...env, ...extra, CRW_TEST_SCRIPT: script }, cwd);
}
const FOLDER = Symbol('settings path is a folder');
const squash = text => String(text || '').replace(/\s+/g, '');
const line = (stdout, label) => stdout.split(/\r?\n/).find(l => l.startsWith(label)) || '';

test('start.ps1 -CheckOnly resolves like server.mjs, reports what it found, and starts or writes nothing', { skip: windowsOnly, timeout: 90_000 }, async t => {
  const base = await tempDir(t, 'crw-check-');
  const data = path.join(base, 'data'); const out = path.join(base, 'out'); const projects = path.join(base, 'projects');
  await mkdir(projects, { recursive: true });
  const codex = await touch(path.join(base, 'fake', 'codex.exe')); const cloudflared = await touch(path.join(base, 'fake', 'cloudflared.exe'));
  await mkdir(data, { recursive: true });
  await writeFile(path.join(data, 'runtime-config.json'), JSON.stringify({ port: 47999, allowedRoots: [projects], resumeRoots: [], codexExe: codex, cloudflaredPath: cloudflared }));
  const settings = path.join(base, 'settings.json');
  await writeFile(settings, JSON.stringify({ dataDir: data, outputDir: out, nodeExe: process.execPath }));
  const env = cleanEnv({ CODEX_REMOTE_SETTINGS: settings, LOCALAPPDATA: path.join(base, 'lad') });

  let r = await checkOnly(env);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const node = resolveSettings({ env });
  assert.ok(line(r.stdout, 'Data folder').includes(`${node.dataDir} [local.settings.json] exists`), r.stdout);
  assert.ok(line(r.stdout, 'Runtime config').includes(`${node.configPath} OK`), r.stdout);
  assert.ok(line(r.stdout, 'Output folder').includes(`${node.outputDir} [local.settings.json]`), r.stdout);
  assert.ok(line(r.stdout, 'Node').includes(`${process.execPath} [local.settings.json] ${process.version} OK`), r.stdout);
  assert.ok(line(r.stdout, 'Codex').includes(`${codex} [config] OK`), r.stdout);
  assert.ok(line(r.stdout, 'cloudflared').includes(`${cloudflared} [runtime-config.json] OK`), r.stdout);
  assert.ok(line(r.stdout, 'URL file').includes(path.join(out, 'CodexRemoteWeb-url.txt')), r.stdout);
  assert.ok(line(r.stdout, 'allowedRoots').includes(`${projects} (exists)`), r.stdout);
  assert.equal(existsSync(path.join(data, 'logs')), false); assert.equal(existsSync(out), false);

  // Parameter > environment > settings file; a missing runtime config is reported (exit 1) and nothing is created.
  const third = path.join(base, 'third');
  r = await checkOnly({ ...env, CODEX_REMOTE_DATA_DIR: path.join(base, 'from-env') }, ['-DataDir', third]);
  assert.equal(r.code, 1);
  assert.ok(line(r.stdout, 'Data folder').includes(`${third} [parameter] not created yet`), r.stdout);
  assert.ok(line(r.stdout, 'Runtime config').includes('MISSING - run: node setup.mjs'), r.stdout);
  assert.ok(line(r.stdout, 'Output folder').includes(`${out} [local.settings.json]`), r.stdout);
  assert.equal(existsSync(third), false);
  r = await checkOnly({ ...env, CODEX_REMOTE_DATA_DIR: path.join(base, 'from-env') });
  assert.ok(line(r.stdout, 'Data folder').includes(`${path.join(base, 'from-env')} [env:CODEX_REMOTE_DATA_DIR]`), r.stdout);

  // No settings file at all: the portable default under LOCALAPPDATA, the same folder server.mjs would use.
  const bare = cleanEnv({ CODEX_REMOTE_SETTINGS: path.join(base, 'absent.json'), LOCALAPPDATA: path.join(base, 'lad'), PATH: `${path.dirname(process.execPath)};${process.env.PATH || ''}` });
  // process.env.PATH is case-insensitive on Windows, so the line above keeps the caller's PATH after node's folder.
  r = await checkOnly(bare);
  const expected = resolveSettings({ env: bare });
  assert.equal(expected.dataDir, path.join(base, 'lad', 'CodexRemoteWeb', 'data'));
  assert.ok(line(r.stdout, 'Data folder').includes(`${expected.dataDir} [default]`), r.stdout);
  assert.ok(line(r.stdout, 'Output folder').includes(`${expected.dataDir} [default]`), r.stdout);
  assert.ok(line(r.stdout, 'Node').includes('[PATH]'), r.stdout);
  assert.equal(existsSync(path.join(base, 'lad')), false);
});

test('start.ps1 and stop.ps1 carry the same path-resolution block', { skip: windowsOnly }, async () => {
  const block = async file => {
    const text = (await readFile(path.join(repo, file), 'utf8')).replace(/\r\n/g, '\n');
    const start = text.indexOf('# --- shared path resolution'); const end = text.indexOf('# --- end shared path resolution ---');
    assert.ok(start >= 0 && end > start, `${file} has the shared block markers`);
    return text.slice(start, end);
  };
  const [a, b] = await Promise.all([block('start.ps1'), block('stop.ps1')]);
  assert.ok(a.includes('function Resolve-Setting') && a.includes('function Read-JsonFile'));
  assert.equal(a, b, 'stop.ps1 must resolve dataDir with exactly the start.ps1 code (stop.ps1 itself is not run by tests)');
});

test('start.ps1 and server.mjs resolve the same settings the same way: values and errors', { skip: windowsOnly, timeout: 180_000 }, async t => {
  const base = await tempDir(t, 'crw-parity-');
  const lad = path.join(base, 'lad');
  const cases = [
    ['forward-slash drive path', { dataDir: 'C:/x/data' }],
    // Unreachable share: -CheckOnly must report it, not crash on Test-Path's IOException.
    ['UNC path', { dataDir: '\\\\localhost\\crw-no-such-share\\data', outputDir: 'D:\\out' }],
    ['key case differs (not the key)', { DataDir: 'D:\\x' }],
    ['null and blank mean not set', { dataDir: null, outputDir: '   ' }],
    ['surrounding blanks trimmed', { dataDir: '  D:\\trim\\data  ' }],
    ['drive-relative refused', { dataDir: 'C:rel' }],
    ['root-relative refused', { dataDir: '\\rooted' }],
    ['relative refused', { dataDir: 'rel\\data' }],
    ['array refused', { dataDir: [] }],
    ['object refused', { outputDir: {} }],
    ['number refused', { dataDir: 5 }],
    ['boolean refused', { outputDir: true }],
    ['nodeExe number refused', { nodeExe: 7 }],
    ['keys differing only in case', '{"dataDir":"C:\\\\a","DataDir":"C:\\\\b"}'],
    ['top-level array', '[1]'],
    ['null document', 'null'],
    ['broken JSON', '{ "dataDir": '],
    ['empty file', ''],
    ['environment drive-relative refused', { dataDir: 'D:\\file' }, { CODEX_REMOTE_DATA_DIR: 'C:rel' }],
    ['environment wins over a bad file value', { dataDir: 5 }, { CODEX_REMOTE_DATA_DIR: 'D:\\env\\data' }],
    ['settings path is a folder', FOLDER],
    ['Korean and space in the value', { dataDir: 'D:\\한글 폴더\\data' }]
  ];
  const results = await Promise.all(cases.map(async ([name, content, extraEnv = {}], index) => {
    const file = path.join(base, `settings-${index}.json`);
    if (content === FOLDER) await mkdir(file, { recursive: true });
    else await writeFile(file, typeof content === 'string' ? content : JSON.stringify(content));
    const env = cleanEnv({ CODEX_REMOTE_SETTINGS: file, LOCALAPPDATA: lad, PATH: `${path.dirname(process.execPath)};${process.env.PATH || ''}`, ...extraEnv });
    let node; try { node = { ok: resolveSettings({ env }) }; } catch (error) { node = { error: error.message }; }
    return { name, node, ps: await checkOnly(env) };
  }));
  for (const { name, node, ps } of results) {
    if (node.ok) {
      assert.ok(line(ps.stdout, 'Data folder').includes(`${node.ok.dataDir} [${node.ok.dataDirSource.replace(/^local\.settings\.json$/, 'local.settings.json')}]`), `${name}: ${ps.stdout}${ps.stderr}`);
      assert.ok(line(ps.stdout, 'Output folder').includes(`${node.ok.outputDir} [${node.ok.outputDirSource}]`), `${name}: ${ps.stdout}${ps.stderr}`);
    } else {
      assert.notEqual(ps.code, 0, `${name}: PowerShell accepted what server.mjs refused (${node.error})`);
      assert.equal(line(ps.stdout, 'Data folder'), '', `${name}: nothing resolved`);
      assert.ok(squash(ps.stderr).includes(squash(node.error)), `${name}: same error expected\n node: ${node.error}\n ps: ${ps.stderr}`);
    }
  }
});

test('start.ps1 never prints runtime-config or settings content when the JSON is broken', { skip: windowsOnly, timeout: 90_000 }, async t => {
  const base = await tempDir(t, 'crw-leak-');
  const data = path.join(base, 'data'); await mkdir(data, { recursive: true });
  const secrets = ['FAKE-SALT-7c1e0000', 'FAKE-HASH-9d2f0000', 'FAKE-SESSION-KEY-4b8a0000', 'fake-origin-3e5d.example'];
  // \q is an invalid JSON escape: PowerShell 5.1 ConvertFrom-Json used to echo the whole file in its error.
  await writeFile(path.join(data, 'runtime-config.json'), `{ "port": 47999, "password": { "salt": "${secrets[0]}", "hash": "${secrets[1]}" }, "sessionKey": "${secrets[2]}", "publicOrigin": "https://${secrets[3]}", "codexExe": "C:\\q\\bad" }`);
  const settings = path.join(base, 'settings.json');
  await writeFile(settings, JSON.stringify({ dataDir: data, nodeExe: process.execPath }));
  let r = await checkOnly(cleanEnv({ CODEX_REMOTE_SETTINGS: settings, LOCALAPPDATA: path.join(base, 'lad') }));
  assert.equal(r.code, 1);
  assert.ok(line(r.stdout, 'Runtime config').includes(`runtime-config.json is not valid JSON: ${path.join(data, 'runtime-config.json')}`), r.stdout);
  for (const secret of secrets) assert.ok(!r.stdout.includes(secret) && !r.stderr.includes(secret), `${secret} leaked:\n${r.stdout}\n${r.stderr}`);
  const brokenSettings = path.join(base, 'broken.json');
  await writeFile(brokenSettings, `{ "dataDir": "C:\\q", "note": "FAKE-SETTINGS-SECRET-1a2b" `);
  r = await checkOnly(cleanEnv({ CODEX_REMOTE_SETTINGS: brokenSettings, LOCALAPPDATA: path.join(base, 'lad') }));
  assert.notEqual(r.code, 0);
  assert.ok(squash(r.stderr).includes(squash(`${brokenSettings} is not valid JSON`)), r.stderr);
  assert.ok(!r.stdout.includes('FAKE-SETTINGS-SECRET') && !r.stderr.includes('FAKE-SETTINGS-SECRET'), r.stderr);
});

test('start.ps1 -CheckOnly counts a failed Codex lookup as missing instead of showing it OK', { skip: windowsOnly, timeout: 60_000 }, async t => {
  const base = await tempDir(t, 'crw-probe-');
  // A copy of start.ps1 without bridge/app-server.mjs next to it: the Node lookup cannot load and must not pass.
  const alt = path.join(base, 'alt'); await mkdir(alt, { recursive: true }); await copyFile(path.join(repo, 'start.ps1'), path.join(alt, 'start.ps1'));
  const data = path.join(base, 'data'); await mkdir(data, { recursive: true });
  const codex = await touch(path.join(base, 'fake', 'codex.exe')); const cloudflared = await touch(path.join(base, 'fake', 'cloudflared.exe'));
  await writeFile(path.join(data, 'runtime-config.json'), JSON.stringify({ port: 47999, allowedRoots: [], resumeRoots: [], codexExe: codex, cloudflaredPath: cloudflared }));
  const settings = path.join(base, 'settings.json');
  await writeFile(settings, JSON.stringify({ dataDir: data, nodeExe: process.execPath }));
  const r = await checkOnly(cleanEnv({ CODEX_REMOTE_SETTINGS: settings, LOCALAPPDATA: path.join(base, 'lad') }), [], path.join(alt, 'start.ps1'));
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(line(r.stdout, 'Codex'), /check failed.*MISSING/, r.stdout);
  assert.match(r.stdout, /1 required item\(s\) missing/);
});

// A hard link (or copy) of the running node.exe in a folder with a space and Korean letters.
async function nodeIn(dir) {
  await mkdir(dir, { recursive: true });
  const target = path.join(dir, 'node.exe');
  try { await link(process.execPath, target); } catch { await copyFile(process.execPath, target); }
  return target;
}

test('start.ps1 uses the real node.exe behind a PATH shim, also in non-ASCII folders', { skip: windowsOnly, timeout: 90_000 }, async t => {
  const base = await tempDir(t, 'crw-shim-');
  const realNode = await nodeIn(path.join(base, '노드 폴더'));
  // The shim names its target through a variable: cmd.exe reads .cmd files in the OEM code page.
  const shim = path.join(base, '심 폴더'); await mkdir(shim, { recursive: true });
  await writeFile(path.join(shim, 'node.cmd'), '@"%CRW_REAL_NODE%" %*\r\n');
  const env = cleanEnv({ CODEX_REMOTE_SETTINGS: path.join(base, 'absent.json'), LOCALAPPDATA: path.join(base, 'lad'), CRW_REAL_NODE: realNode, PATH: `${shim};${path.dirname(process.execPath)};${process.env.PATH || ''}` });
  const picked = await runPs('(Get-Command node -CommandType Application | Select-Object -First 1).Source', env);
  assert.equal(picked.stdout.trim().toLowerCase(), path.join(shim, 'node.cmd').toLowerCase(), 'PATH lookup alone would pick the shim');
  const r = await checkOnly(env);
  assert.ok(line(r.stdout, 'Node').includes(`${realNode} [PATH] ${process.version} OK`), r.stdout + r.stderr);
  // A shim that prints nothing: Node is reported missing with guidance instead of crashing.
  await writeFile(path.join(shim, 'node.cmd'), '@exit /b 0\r\n');
  const silent = await checkOnly(env);
  assert.equal(silent.code, 1, silent.stdout + silent.stderr);
  assert.match(line(silent.stdout, 'Node'), /did not report its node\.exe.*nodeExe.*MISSING/, silent.stdout + silent.stderr);
});

test('start.ps1 ignores relative PATH entries (nothing is picked up from the current folder)', { skip: windowsOnly, timeout: 60_000 }, async t => {
  const base = await tempDir(t, 'crw-relpath-');
  const here = path.join(base, 'here'); await mkdir(here, { recursive: true });
  await writeFile(path.join(here, 'node.cmd'), '@echo planted\r\n');
  await touch(path.join(here, 'cloudflared.exe'));
  const env = cleanEnv({ CODEX_REMOTE_SETTINGS: path.join(base, 'absent.json'), LOCALAPPDATA: path.join(base, 'lad'), PATH: `.;${path.dirname(process.execPath)};${process.env.PATH || ''}` });
  const r = await checkOnly(env, [], path.join(repo, 'start.ps1'), here);
  // node.exe is reported with the PATHEXT spelling (node.EXE); file names are case-insensitive.
  assert.ok(line(r.stdout, 'Node').toLowerCase().includes(`${process.execPath} [PATH]`.toLowerCase()), r.stdout + r.stderr);
  assert.ok(!line(r.stdout, 'Node').includes(here) && !line(r.stdout, 'cloudflared').includes(here), r.stdout);
});

test('start.ps1 skips PATH entries with characters invalid in paths instead of stopping', { skip: windowsOnly, timeout: 60_000 }, async t => {
  const base = await tempDir(t, 'crw-badpath-');
  // Some installers leave entries like "C:\x"\bin; .NET Path.Combine throws on the stray quote (and on < > |).
  const env = cleanEnv({ CODEX_REMOTE_SETTINGS: path.join(base, 'absent.json'), LOCALAPPDATA: path.join(base, 'lad'), PATH: `C:\\x"y\\bin;C:\\a<b|c;${path.dirname(process.execPath)};${process.env.PATH || ''}` });
  const r = await checkOnly(env);
  assert.ok(line(r.stdout, 'Node').toLowerCase().includes(`${process.execPath} [PATH]`.toLowerCase()), r.stdout + r.stderr);
  assert.ok(line(r.stdout, 'cloudflared'), r.stdout + r.stderr);
  assert.ok(!/Combine|잘못된 문자|Illegal characters/i.test(r.stdout + r.stderr), r.stdout + r.stderr);
});

test('start.ps1 -CheckOnly works with spaces and Korean letters in every path (console code page independent)', { skip: windowsOnly, timeout: 90_000 }, async t => {
  const base = path.join(await tempDir(t, 'crw-unicode-'), '한글 경로 테스트');
  const data = path.join(base, '데이터 폴더'); const out = path.join(base, '출력 폴더'); const projects = path.join(base, '프로젝트 모음');
  await mkdir(data, { recursive: true }); await mkdir(projects, { recursive: true });
  const codex = await touch(path.join(base, '코덱스 bin', 'codex.exe')); const cloudflared = await touch(path.join(base, '클라우드 bin', 'cloudflared.exe'));
  await writeFile(path.join(data, 'runtime-config.json'), JSON.stringify({ port: 47999, allowedRoots: [projects], resumeRoots: [], codexExe: codex, cloudflaredPath: cloudflared }));
  const realNode = await nodeIn(path.join(base, '노드 실행 파일'));
  const settings = path.join(base, '설정.json');
  await writeFile(settings, JSON.stringify({ dataDir: data, outputDir: out, nodeExe: realNode }));
  const env = cleanEnv({ CODEX_REMOTE_SETTINGS: settings, LOCALAPPDATA: path.join(base, 'lad') });
  const r = await checkOnly(env);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.ok(line(r.stdout, 'Data folder').includes(`${data} [local.settings.json] exists`), r.stdout);
  assert.ok(line(r.stdout, 'Node').includes(`${realNode} [local.settings.json] ${process.version} OK`), r.stdout);
  assert.ok(line(r.stdout, 'Codex').includes(`${codex} [config] OK`), `the Node lookup result must survive the console code page\n${r.stdout}`);
  assert.ok(line(r.stdout, 'cloudflared').includes(`${cloudflared} [runtime-config.json] OK`), r.stdout);
  assert.ok(line(r.stdout, 'allowedRoots').includes(`${projects} (exists)`), r.stdout);
});

test('start.ps1 quotes Start-Process arguments so paths with spaces and Korean letters arrive whole', { skip: windowsOnly, timeout: 60_000 }, async t => {
  const base = path.join(await tempDir(t, 'crw-args-'), '저장소 폴더 with space');
  await mkdir(base, { recursive: true });
  const script = path.join(base, 'echo args.mjs');
  await writeFile(script, "import { writeFileSync } from 'node:fs'; writeFileSync(process.env.CRW_OUT, JSON.stringify(process.argv.slice(1)));\n");
  const expected = [script, 'a b', 'q"x', 'tail\\', 'plain', 'dir with\\trailing\\', ''];
  // The function is taken from start.ps1 itself (not a copy) and used with Start-Process exactly as start.ps1 does.
  const command = [
    '$t = $null; $e = $null; $ast = [System.Management.Automation.Language.Parser]::ParseFile($env:CRW_START, [ref]$t, [ref]$e)',
    "$fn = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'ConvertTo-CommandLine' }, $true) | Select-Object -First 1",
    '. ([scriptblock]::Create($fn.Extent.Text))',
    // Windows PowerShell 5.1 emits a JSON array as one object; the cast unrolls it.
    '$list = [string[]]($env:CRW_ARGS | ConvertFrom-Json)',
    'if ($env:CRW_NAIVE) { $argumentList = @($list[0]) } else { $argumentList = ConvertTo-CommandLine $list }',
    '$p = Start-Process -FilePath $env:CRW_NODE -ArgumentList $argumentList -WorkingDirectory $env:CRW_DIR -WindowStyle Hidden -Wait -PassThru',
    'exit $p.ExitCode'
  ].join('; ');
  const out = path.join(base, 'argv.json');
  const env = cleanEnv({ CRW_START: path.join(repo, 'start.ps1'), CRW_ARGS: JSON.stringify(expected), CRW_NODE: process.execPath, CRW_DIR: base, CRW_OUT: out });
  const r = await runPs(command, env);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.deepEqual(JSON.parse(await readFile(out, 'utf8')), expected);
  // Control: the unquoted form start.ps1 used before splits the script path and node cannot find it.
  const naive = await runPs(command, { ...env, CRW_NAIVE: '1', CRW_OUT: path.join(base, 'naive.json') });
  assert.notEqual(naive.code, 0, 'unquoted -ArgumentList must fail for a path with spaces (otherwise this test proves nothing)');
});
