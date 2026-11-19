import concurrently from 'concurrently';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const java = process.env.BACKEND_JAVA_EXECUTABLE || 'java';
const jarName = process.argv[2];
if (!/^[a-f0-9]{32}\.jar$/.test(jarName ?? '')) throw new Error('Start the development services with npm start.');
const node = `"${process.execPath}"`;
// concurrently terminates all child process trees on Ctrl+C or a service exit.
const { result } = concurrently([
  { name: 'java', command: `"${java}" -jar ../.cache/backend-runtime/${jarName}`, cwd: resolve(root, 'java-backend') },
  { name: 'game', command: `${node} scripts/game-server.mjs`, cwd: root },
  { name: 'web', command: `${node} node_modules/vite/bin/vite.js --strictPort`, cwd: root },
], { killOthersOn: ['success', 'failure'], prefix: 'name', prefixColors: ['cyan', 'green', 'magenta'] });
try { await result; }
catch { process.exitCode = 1; }
