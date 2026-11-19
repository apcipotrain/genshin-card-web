import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiUrl = (process.env.ACCOUNT_API_URL || 'http://127.0.0.1:8080').replace(/\/$/, '');
if (!process.env.GAME_SERVICE_KEY) {
  try { process.env.GAME_SERVICE_KEY = readFileSync(resolve(root, '.cache/game-service-key'), 'utf8').trim(); }
  catch { throw new Error('Missing game service key. Start with npm start, or run npm run backend first.'); }
}

console.log(`[game] Waiting for account API at ${apiUrl}...`);
let ready = false;
for (let attempt = 0; attempt < 90; attempt++) {
  try {
    const response = await fetch(`${apiUrl}/api/health`, { signal: AbortSignal.timeout(1500) });
    if (response.ok && (await response.json()).status === 'ok') { ready = true; break; }
  } catch { /* Spring needs a moment to start. */ }
  await delay(1000);
}
if (!ready) throw new Error('Account API did not become ready. Check Java logs or run npm run backend in another terminal.');

const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
  cwd: root,
  env: process.env,
  stdio: 'inherit',
  windowsHide: true,
});
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { child.kill(signal); });
}
