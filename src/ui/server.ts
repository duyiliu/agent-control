import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppLog } from '../telemetry/logging.js';
import { approveMergeTask, OpsError, retryTask, stopTask } from '../ops.js';
import {
  addProjectPayload,
  artifactPayload,
  healthPayload,
  projectsPayload,
  tailPayload,
  taskPayload,
  tasksPayload,
  type UiDeps,
} from './api.js';

export interface UiServer {
  close: () => void;
  url: string;
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

// src/ui/server.ts (tsx) or dist/ui/server.js (built) → repo root is two levels up.
const UI_DIST = resolve(dirname2(fileURLToPath(import.meta.url)), '..', '..', 'ui', 'dist');

function dirname2(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i > 0 ? p.slice(0, i) : '.';
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function serveStatic(path: string, res: ServerResponse): boolean {
  const rel = path === '/' ? 'index.html' : path.replace(/^\/+/, '');
  const file = resolve(join(UI_DIST, rel));
  // Only files strictly inside ui/dist are servable — the trailing separator
  // keeps a sibling like ui/dist2 from passing the prefix check.
  if (!file.startsWith(UI_DIST + sep)) return false;
  // A directory passes existsSync but makes the read stream emit EISDIR;
  // on a directory fd that error is uncaught and kills the process.
  const st = statSync(file, { throwIfNoEntry: false });
  if (!st?.isFile()) return false;
  res.writeHead(200, {
    'content-type': MIME[extname(file)] ?? 'application/octet-stream',
    // index.html must not be cached: it pins the hashed bundle name.
    'cache-control': extname(file) === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
  });
  const stream = createReadStream(file);
  stream.on('error', () => {
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
  stream.pipe(res);
  return true;
}

const TOKEN_COOKIE = 'ac_ui_token';

function tokenEq(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function cookieToken(req: IncomingMessage): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === TOKEN_COOKIE) {
      return decodeURIComponent(part.slice(i + 1).trim());
    }
  }
  return null;
}

function bearerToken(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  return h?.startsWith('Bearer ') ? h.slice('Bearer '.length).trim() : null;
}

function unauthorized(res: ServerResponse, isApi: boolean) {
  if (isApi) {
    json(res, 401, { error: 'unauthorized' });
    return;
  }
  res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
  res.end(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
     <body style="font:14px system-ui;background:#0b0d10;color:#d5d9e0;display:grid;place-items:center;min-height:100vh;margin:0">
     <form method="GET" action="/" style="display:flex;gap:8px">
       <input name="token" type="password" autofocus placeholder="access token"
              style="padding:10px 14px;width:280px;background:#15181d;border:1px solid #2a2f37;border-radius:6px;color:#d5d9e0">
       <button style="padding:10px 18px;border:0;border-radius:6px;background:#4f7cff;color:#fff;cursor:pointer">进入</button>
     </form></body>`,
  );
}

// Returns true when the request is allowed to proceed. With no token
// configured the gate is a no-op (loopback-only local usage).
function checkAuth(deps: UiDeps, req: IncomingMessage, res: ServerResponse, url: URL): boolean {
  const expected = deps.config.server.ui.token;
  if (!expected) return true;

  const q = url.searchParams.get('token');
  if (q !== null && tokenEq(q, expected)) {
    // Convert the shareable ?token= URL into a cookie and strip it from the
    // address bar so it never sits in history or Referer headers.
    url.searchParams.delete('token');
    const target = url.pathname + (url.search ? url.search : '');
    res.writeHead(302, {
      location: target || '/',
      'set-cookie': `${TOKEN_COOKIE}=${encodeURIComponent(expected)}; Path=/; HttpOnly; SameSite=Lax`,
    });
    res.end();
    return false;
  }

  const presented = bearerToken(req) ?? cookieToken(req);
  if (presented !== null && tokenEq(presented, expected)) return true;

  unauthorized(res, url.pathname.startsWith('/api/'));
  return false;
}

const MAX_BODY = 64 * 1024;

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        rejectPromise(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) { resolvePromise(null); return; }
      try {
        resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        rejectPromise(new Error('invalid JSON body'));
      }
    });
    req.on('error', rejectPromise);
  });
}

function notBuilt(res: ServerResponse) {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(
    `<!doctype html><meta charset="utf-8"><body style="font:14px system-ui;background:#0b0d10;color:#d5d9e0;padding:40px">
     <h2>web ui 尚未构建</h2>
     <p>在 agent-control 仓库执行 <code>npm run ui:build</code>，然后重启调度器。</p></body>`,
  );
}

async function handle(deps: UiDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname;
  const method = req.method ?? 'GET';

  if (!checkAuth(deps, req, res, url)) return;

  if (method === 'GET' && path === '/api/tasks') {
    json(res, 200, tasksPayload(deps.store));
    return;
  }

  const taskApi = /^\/api\/tasks\/(\d+)$/.exec(path);
  if (method === 'GET' && taskApi) {
    const detail = taskPayload(deps.store, Number(taskApi[1]));
    if (!detail) { json(res, 404, { error: 'no such task' }); return; }
    json(res, 200, detail);
    return;
  }

  if (method === 'GET' && path === '/api/projects') {
    json(res, 200, projectsPayload(deps));
    return;
  }

  if (method === 'POST' && path === '/api/projects') {
    let body: unknown;
    try {
      body = await readBody(req);
    } catch (err) {
      json(res, 400, { error: String(err instanceof Error ? err.message : err) });
      return;
    }
    const out = await addProjectPayload(deps, body);
    json(res, out.status, out.body);
    return;
  }

  if (method === 'GET' && path === '/api/health') {
    json(res, 200, healthPayload(deps));
    return;
  }

  if (method === 'GET' && path === '/api/artifact') {
    const p = url.searchParams.get('path');
    if (!p) { json(res, 400, { error: 'path query param required' }); return; }
    const out = artifactPayload(deps.config.server.logs_dir, p);
    json(res, out.status, out.body);
    return;
  }

  const tailApi = /^\/api\/runs\/([A-Za-z0-9_-]+)\/tail$/.exec(path);
  if (method === 'GET' && tailApi) {
    if (!deps.store.getRun(tailApi[1]!)) { json(res, 404, { error: 'no such run' }); return; }
    const out = tailPayload(
      deps.config.server.logs_dir,
      tailApi[1]!,
      url.searchParams.get('file'),
      url.searchParams.get('offset'),
    );
    json(res, out.status, out.body);
    return;
  }

  const action = /^\/api\/tasks\/(\d+)\/(stop|retry|approve-merge)$/.exec(path);
  if (action && method === 'POST') {
    const task = deps.store.getTaskById(Number(action[1]));
    if (!task) { json(res, 404, { error: 'no such task' }); return; }
    try {
      const message = action[2] === 'stop'
        ? stopTask(deps.store, task)
        : action[2] === 'retry'
          ? await retryTask(deps.store, deps.config, deps.tracker, task)
          : await approveMergeTask(deps.store, deps.tracker, task);
      json(res, 200, { message });
    } catch (err) {
      const status = err instanceof OpsError ? 400 : 500;
      json(res, status, { error: String(err instanceof Error ? err.message : err) });
    }
    return;
  }

  if (path.startsWith('/api/')) {
    json(res, 404, { error: `no route: ${method} ${path}` });
    return;
  }

  if (method === 'GET') {
    if (serveStatic(path, res)) return;
    if (path === '/') { notBuilt(res); return; }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
}

export function startUiServer(opts: {
  deps: UiDeps;
  host: string;
  port: number;
  appLog?: AppLog;
}): Promise<UiServer> {
  const { deps, host, port, appLog } = opts;
  const server: Server = createServer((req, res) => {
    handle(deps, req, res).catch((err) => {
      appLog?.event('ui_request_error', { url: req.url, error: String(err).slice(0, 300) });
      if (!res.headersSent) json(res, 500, { error: 'internal error' });
      else res.end();
    });
  });
  return new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(port, host, () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;
      resolvePromise({
        url: `http://${host}:${actualPort}`,
        close: () => {
          // Undici keep-alive sockets otherwise hold the event loop on Windows.
          server.closeAllConnections();
          server.close();
        },
      });
    });
  });
}
