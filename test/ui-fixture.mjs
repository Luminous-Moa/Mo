// Local-only visual QA fixture. It is never used by the packaged launcher.
// Everything it creates stays under work-artifacts/ui-fixture/ in this repository; it uses FakeCodex, not a real account.
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { scrypt as scryptCallback, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { RemoteServer } from '../server.mjs';
import { FakeCodex, SCENARIO_HELP } from './fake-codex.mjs';
import { sampleFiles } from './fixture-files.mjs';

const scrypt = promisify(scryptCallback);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = path.join(repo, 'work-artifacts', 'ui-fixture');
const projectsRoot = path.join(base, 'projects');
const samplesDir = path.join(base, 'sample-files');
const port = Number(process.env.CRW_FIXTURE_PORT || 47832);
const password = 'local-ui-test-only';
// v2: the store now requires an empty or self-marked folder, so the pre-marker work-artifacts/ui-fixture/uploads
// from earlier runs is left exactly as it was and a fresh folder is used.
const uploadDir = path.join(base, 'uploads-v2');

async function writeSample(name, data) {
  // 'wx' keeps any file already present (including edits the tester made) untouched.
  try { await writeFile(path.join(samplesDir, name), data, { flag: 'wx' }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
}

await mkdir(path.join(projectsRoot, 'demo-project'), { recursive: true });
await mkdir(path.join(projectsRoot, 'second-project'), { recursive: true });
await mkdir(samplesDir, { recursive: true });
for (const sample of sampleFiles()) await writeSample(sample.name, sample.data);
if (process.argv.includes('--large-sample')) await writeSample('reject-too-large-21MiB.txt', Buffer.alloc(21 * 1024 * 1024, 0x61));

const project = await realpath(path.join(projectsRoot, 'demo-project'));
// Stand-in for desktop-app work folders (<resume root>\YYYY-MM-DD\<name>), reachable through resumeRoots only.
const desktopRoot = path.join(base, 'desktop-root');
await mkdir(path.join(desktopRoot, '2026-01-15', 'sample-task'), { recursive: true });
await mkdir(path.join(desktopRoot, '2026-09-23', 'report'), { recursive: true });
const salt = randomBytes(16); const hash = await scrypt(password, salt, 32);
const fake = new FakeCodex({ project, stepMs: 250, seedHistory: true, mergeHistory: process.argv.includes('--split-history') ? false : process.argv.includes('--newline-history') ? '\n\n' : true });
const now = Math.floor(Date.now() / 1000);
const desktopTurn = text => [{ id: `seed-${text.length}`, items: [{ id: `seed-u-${text.length}`, type: 'userMessage', content: [{ type: 'text', text }] }, { id: `seed-a-${text.length}`, type: 'agentMessage', text: '(fixture) 데스크톱 앱에서 진행한 기록입니다.' }] }];
fake.threads.set('fixture-desktop', { id: 'fixture-desktop', name: '데스크톱에서 시작한 작업 (이어가기 가능)', cwd: await realpath(path.join(desktopRoot, '2026-01-15', 'sample-task')), updatedAt: now - 600, active: false, turns: desktopTurn('회의록 정리해줘') });
// thread/resume answers "already has an active writer" (409 guidance in the UI) until the fixture restarts.
fake.threads.set('fixture-desktop-locked', { id: 'fixture-desktop-locked', name: '데스크톱 앱이 열어 둔 작업 (잠김)', cwd: await realpath(path.join(desktopRoot, '2026-09-23', 'report')), updatedAt: now - 120, active: false, turns: desktopTurn('보고서 초안 작성') });
fake.lockedThreads.add('fixture-desktop-locked');
fake.threads.set('fixture-desktop-gone', { id: 'fixture-desktop-gone', name: '폴더가 지워진 예전 작업 (기록만)', cwd: path.join(desktopRoot, '2026-09-01', 'deleted'), updatedAt: now - 86400 * 3, active: false, turns: desktopTurn('예전 작업') });
const server = new RemoteServer({
  bindHost: '127.0.0.1', port, publicOrigin: `http://127.0.0.1:${port}`, allowedRoots: [projectsRoot], resumeRoots: [desktopRoot],
  // Fixture-only Codex home: the writer-lock hint must never open the real ~/.codex lock files.
  codexHome: path.join(base, 'codex-home'),
  uploadDir, password: { salt: salt.toString('base64url'), hash: hash.toString('base64url') }
}, { appServer: fake });
await server.start();
process.stdout.write([
  `UI fixture: http://127.0.0.1:${port}`,
  `Password: ${password}`,
  `Sample files: ${samplesDir}`,
  `Uploads stored in: ${uploadDir}`,
  `Scenario prompts (send as the whole message): ${SCENARIO_HELP.join(', ')}`,
  'Stop with Ctrl+C.', ''
].join('\n'));
process.on('SIGINT', () => server.stop().then(() => process.exit(0)));
process.on('SIGTERM', () => server.stop().then(() => process.exit(0)));
