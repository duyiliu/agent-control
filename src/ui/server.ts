import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createReadStream, existsSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppLog } from '../telemetry/logging.js';
import { OpsError, retryTask, stopTask } from '../ops.js';
import {
  artifactPayload,
  healthPayload,
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
  // Only files inside ui/dist are servable — no traversal.
  if (!file.startsWith(UI_DIST)) return false;
  if (!existsSync(file)) return false;
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
  return true;
}

function notBuilt(res: ServerResponse) {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(
    `<!doctype html><meta charset="utf-8"><body style="font:14px system-ui;background:#0b0d10;color:#d5d9e0;padding:40px">
     <h2>web ui is not built yet</h2>
     <p>Run <code>npm run ui:build</code> in the agent-control repo, then restart the scheduler.</p></body>`,
  );
}

async function handle(deps: UiDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname;
  const method = req.method ?? 'GET';

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

  const action = /^\/api\/tasks\/(\d+)\/(stop|retry)$/.exec(path);
  if (action && method === 'POST') {
    const task = deps.store.getTaskById(Number(action[1]));
    if (!task) { json(res, 404, { error: 'no such task' }); return; }
    try {
      const message = action[2] === 'stop'
        ? stopTask(deps.store, task)
        : await retryTask(deps.store, deps.config, deps.tracker, task);
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
