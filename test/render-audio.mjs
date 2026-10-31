// Renders every sound in a real headless browser and prints levels. On Windows the browser launcher
// detaches from its console, so the page posts its results back to this script instead.
//   node test/render-audio.mjs            levels of each sound
//   node test/render-audio.mjs live-check  the real page, end to end
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const browser = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(existsSync);
if (!browser) { console.error('No Chrome or Edge found.'); process.exit(2); }

let finish;
const result = new Promise((r) => { finish = r; });
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'POST') {
    let body = '';
    for await (const c of req) body += c;
    res.writeHead(204).end();
    finish(body);
    return;
  }
  const path = resolve(join(root, decodeURIComponent(url.pathname)));
  if (!path.startsWith(root + sep)) { res.writeHead(403).end(); return; }
  try {
    const data = await readFile(path);
    res.writeHead(200, { 'Content-Type': types[extname(path)] || 'application/octet-stream' }).end(data);
  } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const page = process.argv[2] || 'audio-render';
const profile = await mkdtemp(join(tmpdir(), 'jelly-audio-'));
spawn(browser, ['--headless=new', '--no-first-run', '--disable-extensions', `--user-data-dir=${profile}`,
  '--autoplay-policy=no-user-gesture-required', '--window-size=1100,800',
  `http://127.0.0.1:${port}/test/${page}.html?report=1`], { stdio: 'ignore', detached: true }).unref();

const timeout = new Promise((r) => setTimeout(() => r('TIMEOUT: the page never reported back'), 90000));
const output = await Promise.race([result, timeout]);
console.log(output);

// Stop only the processes using this run's throwaway profile.
const name = profile.split(sep).pop();
try {
  execFileSync('powershell', ['-NoProfile', '-Command',
    `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${name}*' -and $_.ProcessId -ne $PID } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`], { stdio: 'ignore' });
} catch { /* nothing left to stop */ }
server.close();
await new Promise((r) => setTimeout(r, 800));
await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => {});
process.exit(output.startsWith('DONE') ? 0 : 1);
