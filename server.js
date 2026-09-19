'use strict';
/**
 * WebOS server
 *  - serves the OS frontend (public/)
 *  - virtual filesystem + shell API
 *  - agent bus (SSE down / REST up) so an agent can drive the GUI
 *  - web proxy so the in-OS browser can show real internet pages
 *
 * No external dependencies. Node >= 18.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const vfs = require('./lib/vfs');
const proxy = require('./lib/proxy');
const { createShell } = require('./lib/shell');
const { AgentBus } = require('./lib/agent');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const VERSION = '1.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');

const bus = new AgentBus();
const shell = createShell({ bus, proxy, version: VERSION });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8'
};

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Max-Age', '86400');
  // allow the OS to be embedded anywhere (preview iframes etc.)
  res.removeHeader('X-Frame-Options');
}

function json(res, code, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body)
  });
  res.end(body);
}

function readBody(req, limit = 12 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('payload too large')); req.destroy(); return; }
      data += c;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function parseBody(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  const ct = req.headers['content-type'] || '';
  if (ct.includes('application/json')) { try { return JSON.parse(raw); } catch { return { _raw: raw }; } }
  if (ct.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(raw));
  try { return JSON.parse(raw); } catch { return { _raw: raw }; }
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[\/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) return json(res, 403, { error: 'forbidden' });
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('404 - ' + rel);
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'content-length': st.size,
      'cache-control': ext === '.html' ? 'no-store' : 'public, max-age=60'
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname || '/';
  const q = parsed.query || {};
  cors(res);

  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  try {
    /* ---------------- static OS files ---------------- */
    if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);

    /* ---------------- meta ---------------- */
    if (pathname === '/api/ping') {
      return json(res, 200, { ok: true, version: VERSION, clients: bus.clientCount(), ts: Date.now() });
    }

    /* ---------------- agent bus ---------------- */
    if (pathname === '/api/agent/stream') {
      const clientId = String(q.clientId || ('web-' + Math.random().toString(36).slice(2, 8)));
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        'connection': 'keep-alive',
        'x-accel-buffering': 'no'
      });
      res.write(': connected ' + clientId + '\n\n');
      bus.addClient(clientId, res, req.headers['user-agent'] || '');
      res.write('data: ' + JSON.stringify({ type: 'hello', clientId, version: VERSION }) + '\n\n');
      const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 15000);
      req.on('close', () => { clearInterval(ping); bus.removeClient(clientId); });
      return;
    }

    if (pathname === '/api/agent/report' && req.method === 'POST') {
      const body = await parseBody(req);
      bus.touch(body.clientId);
      bus.report(body.state || body);
      return json(res, 200, { ok: true });
    }

    if (pathname === '/api/agent/result' && req.method === 'POST') {
      const body = await parseBody(req);
      bus.touch(body.clientId);
      const found = bus.deliverResult(body.id, body.result || {});
      return json(res, 200, { ok: true, matched: found });
    }

    if (pathname === '/api/agent/state') {
      const state = bus.state();
      if (q.include === 'none') { delete state.browser; }
      return json(res, 200, state);
    }

    if (pathname === '/api/agent/inbox') {
      const clientId = String(q.clientId || '');
      if (!clientId) return json(res, 400, { error: 'clientId required' });
      bus.touch(clientId);
      return json(res, 200, { commands: bus.drainInbox(clientId) });
    }

    if (pathname === '/api/agent/log') {
      const since = Number(q.since || 0);
      return json(res, 200, { log: bus.log.filter(e => e.seq > since), last: bus.log.length ? bus.log[bus.log.length - 1].seq : 0 });
    }

    if (pathname === '/api/agent/clients') {
      return json(res, 200, { clients: [...bus.clients.values()].map(c => ({ id: c.id, lastSeen: c.lastSeen, ua: c.ua })), primary: bus.primary });
    }

    if (pathname === '/api/agent/cmd' && req.method === 'POST') {
      const body = await parseBody(req);
      const op = body.op || (body.cmd && body.cmd.op);
      if (!op) return json(res, 400, { ok: false, error: 'missing "op"' });
      const timeout = Number(body.timeout || q.timeout || 15000);
      const wantWait = body.wait === true || q.wait === '1' || q.wait === 'true' || body.wait === undefined;
      const promise = bus.dispatch({ op, app: body.app, args: body.args || (body.cmd && body.cmd.args) || {} }, timeout);
      if (!wantWait) {
        promise.catch(() => {});
        return json(res, 202, { ok: true, queued: true, note: 'send wait:true to get the result' });
      }
      const result = await promise;
      return json(res, result.ok === false ? 503 : 200, result);
    }

    /* ---------------- shell ---------------- */
    if (pathname === '/api/exec' && req.method === 'POST') {
      const body = await parseBody(req);
      const r = await shell.run(body.cmd || body.command || body._raw || '', {
        cwd: body.cwd || '/Home',
        sessionId: body.sessionId || 'default'
      });
      return json(res, 200, { ok: r.code === 0, ...r });
    }

    /* ---------------- filesystem ---------------- */
    if (pathname === '/api/fs/list') return json(res, 200, vfs.list(q.path || '/'));
    if (pathname === '/api/fs/read') {
      const r = vfs.read(q.path || '');
      return json(res, r.error ? 404 : 200, r);
    }
    if (pathname === '/api/fs/tree') return json(res, 200, vfs.tree(q.path || '/', Number(q.depth) || 3));
    if (pathname === '/api/fs/search') return json(res, 200, vfs.search(q.q || '', q.path || '/'));
    if (pathname === '/api/fs/stats') return json(res, 200, vfs.stats());
    if (pathname === '/api/fs/write' && req.method === 'POST') {
      const b = await parseBody(req);
      const r = b.action === 'append'
        ? vfs.append(b.path, b.content || '')
        : vfs.write(b.path, b.content == null ? '' : b.content, { createParents: true });
      return json(res, r.error ? 400 : 200, r);
    }
    if (pathname === '/api/fs/mkdir' && req.method === 'POST') {
      const b = await parseBody(req);
      const r = vfs.mkdir(b.path, true);
      return json(res, r.error ? 400 : 200, r);
    }
    if (pathname === '/api/fs/rm' && req.method === 'POST') {
      const b = await parseBody(req);
      const r = vfs.rm(b.path, b.recursive !== false);
      return json(res, r.error ? 400 : 200, r);
    }
    if (pathname === '/api/fs/move' && req.method === 'POST') {
      const b = await parseBody(req);
      const r = b.copy ? vfs.copy(b.from, b.to) : vfs.move(b.from, b.to);
      return json(res, r.error ? 400 : 200, r);
    }

    /* ---------------- web proxy ---------------- */
    if (pathname === '/api/proxy') {
      let target = q.url;
      let postOpts = {};
      if (req.method === 'POST') {
        const raw = await readBody(req);
        postOpts = { method: 'POST', body: raw, contentType: req.headers['content-type'] };
        if (!target) {
          const ct = req.headers['content-type'] || '';
          if (ct.includes('application/json')) {
            try { target = JSON.parse(raw).url; } catch (e) {}
          } else {
            target = new URLSearchParams(raw).get('url');
          }
        }
      }
      if (!target) return json(res, 400, { error: 'missing url' });
      try {
        const r = await proxy.fetchHTML(target, postOpts);
        if (r.kind === 'binary') {
          res.writeHead(302, { location: '/api/proxy/raw?url=' + proxy.encode(r.finalUrl) });
          return res.end();
        }
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store'
        });
        return res.end(r.html);
      } catch (e) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(errorPage(target, e.message));
      }
    }

    if (pathname === '/api/proxy/raw') {
      if (!q.url) return json(res, 400, { error: 'missing url' });
      try {
        const r = await proxy.fetchRaw(q.url, q.ref);
        res.writeHead(r.status && r.status >= 400 ? r.status : 200, {
          'content-type': r.contentType,
          'cache-control': 'public, max-age=300',
          'access-control-allow-origin': '*'
        });
        return res.end(r.body);
      } catch (e) {
        res.writeHead(502, { 'content-type': 'text/plain' });
        return res.end('proxy error: ' + e.message);
      }
    }

    if (pathname === '/api/proxy/text') {
      if (!q.url) return json(res, 400, { error: 'missing url' });
      try { return json(res, 200, await proxy.extractText(q.url)); }
      catch (e) { return json(res, 502, { error: e.message, url: q.url }); }
    }

    if (pathname === '/api/search') {
      try { return json(res, 200, await proxy.search(q.q || '')); }
      catch (e) { return json(res, 502, { error: e.message }); }
    }

    /* ---------------- docs ---------------- */
    if (pathname === '/api/meta') {
      return json(res, 200, {
        name: 'WebOS', version: VERSION,
        apps: shell.APPS,
        endpoints: {
          state: 'GET /api/agent/state',
          cmd: 'POST /api/agent/cmd {op,app,args,wait}',
          exec: 'POST /api/exec {cmd,cwd}',
          fs: 'GET /api/fs/list|read|tree|search , POST /api/fs/write|mkdir|rm|move',
          read: 'GET /api/proxy/text?url=',
          search: 'GET /api/search?q='
        },
        help: shell.HELP
      });
    }

    return json(res, 404, { error: 'no such endpoint: ' + pathname });
  } catch (err) {
    return json(res, 500, { error: String(err && err.message || err) });
  }
});

function errorPage(target, message) {
  return `<!doctype html><html><head><base href="${target}"><title>WebOS - page load failed</title>
<style>body{font-family:ui-sans-serif,system-ui,sans-serif;background:#11131a;color:#e8ecf5;padding:48px;line-height:1.6}
code{background:#1e2230;padding:2px 6px;border-radius:4px}a{color:#7cc4ff}</style></head><body>
<h2>⚠️ Ye page load nahi ho paya</h2>
<p><b>URL:</b> <a href="${target}">${target}</a></p>
<p><b>Reason:</b> ${String(message).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</p>
<p>Tips: url me <code>https://</code> lagao, ya koi dusri site try karo. Search bar (Ctrl+K) bhi use kar sakte ho.</p>
</body></html>`;
}

server.listen(PORT, HOST, () => {
  console.log(`WebOS ${VERSION} running on http://${HOST}:${PORT}`);
  console.log(`   desktop : http://localhost:${PORT}/`);
  console.log(`   agent   : GET  http://localhost:${PORT}/api/agent/state`);
  console.log(`             POST http://localhost:${PORT}/api/agent/cmd`);
});

// keep SSE pipes alive
setInterval(() => { for (const [, c] of bus.clients) { try { c.res.write(': ka\n\n'); } catch (e) {} } }, 25000);
