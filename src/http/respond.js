/**
 * Response helpers, static file serving and CORS.
 * Every JSON response carries the engine and its disclaimer, so no client can
 * accidentally present these numbers as real Meesho data.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SERVICE } from '../config/deck.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PUBLIC_DIR = path.resolve(__dirname, '../../public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

export function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Seller-Id');
  res.setHeader('Access-Control-Max-Age', '86400');
}

export function json(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body, null, 2);
  /* A header set to undefined is a hard crash in Node's writeHead, and a crash
     here would turn "replay this stored answer" into a 500. Drop them. */
  const headers = Object.fromEntries(Object.entries(extraHeaders).filter(([, v]) => v !== undefined && v !== null));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'X-ProfitPilot-Engine': `${SERVICE.engine} (${SERVICE.version})`,
    'X-Disclaimer': 'Illustrative planning defaults from the DICE S3 deck. Not real Meesho data.',
    ...headers,
  });
  res.end(payload);
}

export const ok = (res, body, extra) => json(res, 200, withMeta(body), extra);

/** Wrap every payload with provenance so the UI can print where a number came from. */
export function withMeta(body) {
  if (body && typeof body === 'object' && !Array.isArray(body) && body._meta === undefined) {
    return { ...body, _meta: { engine: SERVICE.engine, generatedAt: new Date().toISOString(), disclaimer: SERVICE.banner } };
  }
  return body;
}

export function fail(res, status, message, detail) {
  return json(res, status, { error: { status, message, detail: detail || null }, _meta: { engine: SERVICE.engine } });
}

export function notFound(res, pathname) {
  return fail(res, 404, `no route for ${pathname}`, 'GET /api/routes lists every endpoint');
}

/** Serve a file from public/ (the wired front-end lives there). */
export function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) return notFound(res, pathname);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return notFound(res, pathname);
  const ext = path.extname(file).toLowerCase();
  const body = fs.readFileSync(file);
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': body.length,
    'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=60',
  });
  res.end(body);
}

export function serveIndex(res) {
  const file = path.join(PUBLIC_DIR, 'index.html');
  if (!fs.existsSync(file)) return fail(res, 500, 'public/index.html is missing');
  return serveStatic(res, '/');
}
