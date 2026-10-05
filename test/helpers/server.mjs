/**
 * TEST HELPER: boot the real server as a child process on a free port.
 *
 * The security and end-to-end tests talk to actual HTTP, because half of what
 * they check (sessions, scoping, admin protection, idempotency headers,
 * correlation ids) only exists at the edge. Nothing about the server is
 * mocked: it is `node server.js` with an isolated PP_DATA_DIR.
 */

import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

export async function startServer(env = {}) {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-http-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', PP_DATA_DIR: dataDir, PP_LOG: 'off', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { out += d.toString(); });

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20000;
  let up = false;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(base + '/api/health');
      if (r.ok) { up = true; break; }
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 120));
  }
  if (!up) {
    child.kill('SIGKILL');
    throw new Error(`server did not start on ${port}:\n${out}`);
  }

  const api = async (path_, { method = 'GET', body, headers = {}, token = null, adminToken = null } = {}) => {
    const h = { ...headers };
    if (body !== undefined) h['content-type'] = 'application/json';
    if (token) h.authorization = `Bearer ${token}`;
    if (adminToken) h['x-admin-token'] = adminToken;
    const res = await fetch(base + path_, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON */ }
    return { status: res.status, headers: res.headers, text, body: json };
  };

  return {
    base,
    port,
    dataDir,
    api,
    log: () => out,
    stop: async () => {
      child.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 250));
      if (!child.killed) child.kill('SIGKILL');
      try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
    },
  };
}
