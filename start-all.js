#!/usr/bin/env node
/**
 * start-all.js - Cross-platform launcher for the AI Usage Dashboard stack
 *
 * Usage:
 *   node start-all.js              # start everything
 *   node start-all.js --no-collector
 *   node start-all.js --no-server
 *   node start-all.js --no-web
 *   node start-all.js --server-port 8787 --web-port 3000
 */

import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import process from 'process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = __dirname;
const collectorDir = join(repoRoot, 'collector');
const serverDir = join(repoRoot, 'server');
const webDir = join(repoRoot, 'web');

const args = process.argv.slice(2);

// Parse args properly (handle flags without values)
function parseArgs(argv) {
  const opts = {
    noCollector: false,
    noServer: false,
    noWeb: false,
    serverPort: '8787',
    webPort: '3000',
    collectorDays: '30',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--no-collector') opts.noCollector = true;
    else if (arg === '--no-server') opts.noServer = true;
    else if (arg === '--no-web') opts.noWeb = true;
    else if (arg === '--server-port' && argv[i + 1]) { opts.serverPort = argv[++i]; }
    else if (arg === '--web-port' && argv[i + 1]) { opts.webPort = argv[++i]; }
    else if (arg === '--collector-days' && argv[i + 1]) { opts.collectorDays = argv[++i]; }
  }
  return opts;
}

const options = parseArgs(args);

const children = [];
let shuttingDown = false;

function log(prefix, msg) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [${prefix}] ${msg}`);
}

function run(cmd, cwd, env = {}) {
  return new Promise((resolve, reject) => {
    const [exe, ...cmdArgs] = cmd.split(' ');
    const child = spawn(exe, cmdArgs, {
      cwd,
      env: { ...process.env, ...env },
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`${cmd} exited with ${code}`)));
    child.on('error', reject);
    return child;
  });
}

async function checkPrereqs() {
  log('start', 'Checking prerequisites...');
  const checks = [
    { cmd: 'bun --version', name: 'Bun' },
    { cmd: 'node --version', name: 'Node.js' },
    { cmd: 'npm --version', name: 'npm' },
  ];
  for (const c of checks) {
    try {
      await run(c.cmd, repoRoot);
      log('start', `  ✓ ${c.name}`);
    } catch {
      log('start', `✗ Missing ${c.name} - install it first`);
      process.exit(1);
    }
  }
}

function checkEnvFiles() {
  const envFiles = [
    { path: join(collectorDir, '.env'), label: 'collector/.env' },
    { path: join(serverDir, '.env'), label: 'server/.env' },
    { path: [join(webDir, '.env.local'), join(webDir, '.env')], label: 'web/.env.local (or web/.env)' },
  ];
  for (const ef of envFiles) {
    const paths = Array.isArray(ef.path) ? ef.path : [ef.path];
    if (!paths.some((p) => fs.existsSync(p))) {
      log('start', `⚠ ${ef.label} not found - copy from .env.example`);
    }
  }
}

async function waitForHttp(url, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 4000);
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(t);
      if (res.ok || res.status < 500) {
        log('start', `  ✓ ${label} is up (${url})`);
        return true;
      }
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 2000));
  }
  log('start', `  ✗ ${label} did NOT come up at ${url} — check its logs above`);
  return false;
}

async function runCollector() {
  log('collector', `Dry-run (--days ${options.collectorDays})...`);
  try {
    await run(
      `bun run index.ts -- --days ${options.collectorDays} --dry-run`,
      collectorDir,
      { PATH: process.env.PATH + (process.platform === 'win32' ? ';C:\\Users\\' + process.env.USERNAME + '\\.bun\\bin' : '') }
    );
    log('collector', 'Dry-run OK');
  } catch (e) {
    log('collector', `FAILED: ${e.message}`);
    process.exit(1);
  }
}

function startServer() {
  return run(`npm run dev`, serverDir, { PORT: options.serverPort });
}

function startWeb() {
  return run(`npx next dev --port ${options.webPort}`, webDir);
}

async function main() {
  console.log('\n╔═══════════════════════════════════════════════╗');
  console.log('║     AI Usage Dashboard - Local Stack         ║');
  console.log('╚═══════════════════════════════════════════════╝\n');

  await checkPrereqs();
  checkEnvFiles();

  if (!options.noCollector) await runCollector();

  if (!options.noServer) {
    log('server', `Starting on :${options.serverPort}...`);
    startServer().catch(e => log('server', `FAILED: ${e.message}`));
    await waitForHttp(`http://localhost:${options.serverPort}/health`, 45000, 'server');
  }

  if (!options.noWeb) {
    log('web', `Starting on :${options.webPort}...`);
    startWeb().catch(e => log('web', `FAILED: ${e.message}`));
    await waitForHttp(`http://localhost:${options.webPort}/`, 120000, 'web');
  }

  console.log('\n═══════════════════════════════════════════════');
  console.log(`Server:  http://localhost:${options.serverPort}`);
  console.log(`Web:     http://localhost:${options.webPort}`);
  console.log('');
  console.log('API endpoints:');
  console.log(`  POST http://localhost:${options.serverPort}/v1/ingest`);
  console.log(`  GET  http://localhost:${options.serverPort}/v1/summary?day=YYYY-MM-DD`);
  console.log(`  GET  http://localhost:${options.serverPort}/v1/last-day`);
  console.log(`  GET  http://localhost:${options.serverPort}/health`);
  console.log('');
  console.log(`Collector: bun ${collectorDir}/index.ts -- --push`);
  console.log('Press Ctrl+C to stop all.\n');

  // Handle shutdown
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('start', 'Shutting down...');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Keep alive
  await new Promise(() => {});
}

main().catch(e => {
  log('start', `Fatal: ${e.message}`);
  process.exit(1);
});
