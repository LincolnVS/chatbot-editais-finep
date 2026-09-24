// Sobe docling-serve, API e frontend num terminal só (Ctrl+C encerra os três).
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';

function portInUse(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

const children = [];
function run(name, script, color) {
  const child = isWin
    ? spawn('cmd.exe', ['/d', '/s', '/c', `npm run ${script}`], { cwd: ROOT, env: process.env })
    : spawn('npm', ['run', script], { cwd: ROOT, env: process.env });
  const prefix = `\x1b[${color}m[${name}]\x1b[0m `;
  const pipe = (stream) => {
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) process.stdout.write(prefix + line + '\n');
    });
  };
  pipe(child.stdout);
  pipe(child.stderr);
  child.on('exit', (code) => process.stdout.write(`${prefix}encerrado (${code ?? 'sinal'})\n`));
  children.push(child);
}

if (await portInUse(5001)) console.log('[docling] já está no ar na porta 5001');
else run('docling', 'dev:docling', '35');
if (await portInUse(3000)) console.log('[api] já está no ar na porta 3000');
else run('api', 'dev:api', '36');
if (await portInUse(5173)) console.log('[web] já está no ar na porta 5173');
else run('web', 'dev:web', '32');

console.log('\nAbra http://localhost:5173 (Ctrl+C encerra tudo)\n');

function shutdown() {
  for (const child of children) {
    if (isWin) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill('SIGINT');
  }
  setTimeout(() => process.exit(0), 500);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
