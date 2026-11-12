// One command for local development: API (tsx) + Vite UI. Ctrl+C stops both.
import { spawn } from 'node:child_process';

const procs = [
  spawn('npm', ['run', 'api'], { stdio: 'inherit' }),
  spawn('npm', ['run', 'dev'], { stdio: 'inherit' }),
];
const stop = () => procs.forEach((p) => p.kill('SIGTERM'));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
procs.forEach((p) => p.on('exit', (code) => { if (code) { stop(); process.exitCode = code; } }));
