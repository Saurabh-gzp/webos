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
const { ChromiumSessions } = require('./lib/chromium');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const VERSION = '1.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');

const bus = new AgentBus();
const chromium = new ChromiumSessions();
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
  if (res.headersSent || res.writableEnded) return res;   // already answered
  let body;
  try {
    body = JSON.stringify(obj === undefined ? null : obj, null, 2);
  } catch (e) {
    body = JSON.stringify({ error: 'response serialization failed: ' + e.message, ok: false });
    code = 500;
  }
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body)
  });
  return res.end(body);
}

/** Public origin of this request — Render/Vercel ke proxy headers bhi handle karta hai. */
function originOf(req) {
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  const host = (req.headers['x-forwarded-host'] || req.headers.host || 'localhost').split(',')[0].trim();
  return proto + '://' + host;
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

      /* server-side ops: Chromium seedha HTTP se chalega — OS window khula ho ya na ho */
      const opLower = String(op).toLowerCase();
      if (opLower.startsWith('chromium.')) {
        const args = body.args || (body.cmd && body.cmd.args) || {};
        const verb = opLower.slice('chromium.'.length);
        try {
          // session chuno: diya hua id → sabse recent chalu session → warna naya
          const pickSession = async () => {
            if (args.sessionId) {
              const s = chromium.getSession(args.sessionId);
              if (s) return s;
            }
            if (!args.new && !args.newSession) {
              const recent = chromium.list().sort((a, b) => b.lastUsed - a.lastUsed)[0];
              if (recent) {
                const s = chromium.getSession(recent.id);
                if (s) return s;
              }
            }
            return await chromium.createSession(args);
          };
          switch (verb) {
            case 'status': case 'sessions':
              return json(res, 200, { ok: true, ...chromium.status() });
            case 'open': case 'new': {
              const session = await chromium.createSession(args);
              const out = args.url ? await chromium.goto(session, args.url, { limit: 4000 }) : await chromium.snapshot(session, { limit: 2000 });
              bus.pushLog('chromium', 'session open ' + session.id + (args.url ? ' → ' + args.url : ''));
              return json(res, 200, { ok: true, sessionId: session.id, ...out });
            }
            case 'goto': case 'navigate': case 'open-url': {
              const session = await pickSession();
              const out = await chromium.goto(session, args.url || args.value, { limit: 4000 });
              bus.pushLog('chromium', 'goto ' + (args.url || args.value));
              return json(res, out.ok === false ? 400 : 200, { sessionId: session.id, ...out });
            }
            case 'act': case 'do': {
              const session = await pickSession();
              const action = String(args.action || args.op || '').toLowerCase();
              const map = {
                click: () => chromium.click(session, args),
                type: () => chromium.type(session, args),
                fill: () => chromium.type(session, args),
                press: () => chromium.press(session, args),
                key: () => chromium.press(session, args),
                scroll: () => chromium.scroll(session, args),
                eval: () => chromium.evalJs(session, args.code || args.value),
                extract: () => chromium.extract(session),
                read: () => chromium.extract(session),
                navigate: () => chromium.goto(session, args.url || args.value, args),
                goto: () => chromium.goto(session, args.url || args.value, args),
                back: () => chromium.back(session),
                forward: () => chromium.forward(session),
                reload: () => chromium.reload(session),
                state: () => chromium.snapshot(session, { limit: 4000, elements: 'all' }),
                screenshot: async () => {
                  const shot = await chromium.screenshot(session, args);
                  const dir = '/Home/Screenshots';
                  try { vfs.mkdir(dir, true); } catch (e) {}
                  const name = 'shot-' + Date.now() + (shot.contentType === 'image/png' ? '.png' : '.jpg');
                  const path = dir + '/' + name;
                  vfs.writeBinary ? vfs.writeBinary(path, shot.buffer) : vfs.write(path, shot.buffer.toString('base64'), { createParents: true });
                  return { ok: true, path, bytes: shot.buffer.length, contentType: shot.contentType };
                }
              };
              if (!map[action]) return json(res, 400, { ok: false, error: 'action chahiye: ' + Object.keys(map).join(', ') });
              const out = await map[action]();
              bus.pushLog('chromium', action + ' → ' + session.url);
              return json(res, out && out.ok === false ? 400 : 200, { sessionId: session.id, ...out });
            }
            case 'task': case 'run': {
              const actions = args.actions || args.steps || (Array.isArray(args) ? args : []);
              if (!actions.length) return json(res, 400, { ok: false, error: 'args.actions[] chahiye' });
              const out = await chromium.runTask(actions, args);
              bus.pushLog('chromium', 'task ' + out.steps + '/' + out.total + (out.ok ? ' ok' : ' FAILED'));
              return json(res, out.ok ? 200 : 400, out);
            }
            case 'screenshot': case 'shot': {
              const session = await pickSession();
              const shot = await chromium.screenshot(session, args);
              try { vfs.mkdir('/Home/Screenshots', true); } catch (e) {}
              const path = '/Home/Screenshots/shot-' + Date.now() + (shot.contentType === 'image/png' ? '.png' : '.jpg');
              vfs.writeBinary ? vfs.writeBinary(path, shot.buffer) : vfs.write(path, shot.buffer.toString('base64'), { createParents: true });
              return json(res, 200, { ok: true, path, bytes: shot.buffer.length, url: session.url, title: session.title });
            }
            case 'frame': {
              const session = await pickSession();
              await chromium.refreshFrame(session);
              return json(res, 200, { ok: true, jpeg: session.lastFrame, url: session.url, title: session.title });
            }
            case 'close': {
              if (args.all) { await chromium.closeAll(); return json(res, 200, { ok: true, closed: 'all' }); }
              const session = await pickSession();
              await chromium.closeSession(session.id);
              return json(res, 200, { ok: true, closed: session.id });
            }
            default:
              return json(res, 404, { ok: false, error: 'unknown chromium op: ' + op, ops: ['chromium.open', 'chromium.goto', 'chromium.act', 'chromium.task', 'chromium.screenshot', 'chromium.frame', 'chromium.status', 'chromium.close'] });
          }
        } catch (e) {
          if (e && /puppeteer|Chromium|browser process|Failed to launch/i.test(e.message || '')) {
            return json(res, 503, { ok: false, error: e.message, hint: 'server pe Chromium available nahi hai — npm install puppeteer karo (Docker/Render build ise karta hai)' });
          }
          return json(res, 500, { ok: false, error: e.message });
        }
      }

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
    if (pathname === '/api/fs/raw') {
      const r = vfs.readBinary(q.path || '');
      if (r.error) return json(res, 404, { ok: false, error: r.error });
      res.writeHead(200, { 'content-type': r.mime, 'cache-control': 'no-store', 'content-length': r.buffer.length });
      return res.end(r.buffer);
    }
    if (pathname === '/api/fs/tree') return json(res, 200, vfs.tree(q.path || '/', Number(q.depth) || 3));
    if (pathname === '/api/fs/search') return json(res, 200, vfs.search(q.q || '', q.path || '/'));
    if (pathname === '/api/fs/stats') return json(res, 200, vfs.stats());
    if (pathname === '/api/fs/write' && req.method === 'POST') {
      const b = await parseBody(req);
      let r;
      if (b.binary) {
        // screenshots / downloads: content base64 me aata hai
        r = vfs.writeBinary(b.path, b.content || '', { mime: b.mime, createParents: true });
      } else {
        r = b.action === 'append'
          ? vfs.append(b.path, b.content || '')
          : vfs.write(b.path, b.content == null ? '' : b.content, { createParents: true });
      }
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
        const r = await proxy.fetchHTML(target, { ...postOpts, proxyBase: originOf(req) });
        if (r.kind === 'binary') {
          res.writeHead(302, { location: '/api/proxy/raw?url=' + proxy.encode(r.finalUrl) });
          return res.end();
        }
        // (relative redirects are fine: the browser resolves them against OUR host,
        // because this response is the top-level document, not an injected base)
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
        const r = await proxy.fetchRaw(q.url, q.ref, originOf(req));
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

    /* ================= real Chromium browser =================
       Server pe headless Chromium chalta hai; UI live screencast dekhta hai,
       agent wahi session REST se drive karta hai (Manus-jaisa live browser).
       Ops: sessions, navigate, act, state, screenshot, frame, stream,
            click, type, key, scroll, eval, extract, back/forward/reload, task */
    if (pathname.startsWith('/api/browser')) {
      const rest = pathname.slice('/api/browser'.length).split('/').filter(Boolean);
      const withSession = async (fn) => {
        const session = chromium.getSession(rest[0]);
        if (!session) return json(res, 404, { ok: false, error: 'session not found: ' + rest[0], sessions: chromium.list() });
        let out;
        try {
          out = await fn(session);
        } catch (e) {
          return json(res, 500, { ok: false, error: e.message });
        }
        if (res.headersSent || res.writableEnded) return;      // handler ne khud jawab diya
        return json(res, out && out.ok === false ? 400 : 200, out);
      };

      // ---- collection level ----
      if (!rest.length) {
        const info = chromium.status();
        if (req.method === 'POST') {
          const b = await parseBody(req);
          try {
            const session = await chromium.createSession(b);
            if (b.url) await chromium.goto(session, b.url, { limit: 4000 });
            return json(res, 200, { ok: true, sessionId: session.id, ...(await chromium.snapshot(session, { limit: 4000 })), status: chromium.status() });
          } catch (e) {
            return json(res, 503, { ok: false, error: e.message, hint: 'npm install puppeteer (ya render.yaml ka build dekho)', status: chromium.status() });
          }
        }
        return json(res, 200, { ok: true, ...info });
      }

      if (rest[0] === 'status') return json(res, 200, { ok: true, ...chromium.status() });

      if (rest[0] === 'sessions') {
        if (req.method === 'DELETE') { await chromium.closeAll(); return json(res, 200, { ok: true, closed: 'all' }); }
        return json(res, 200, { ok: true, sessions: chromium.list() });
      }

      // ---- task runner (Manus-style): {sessionId?, actions:[{action,...}]} ----
      if (rest[0] === 'task') {
        const b = await parseBody(req);
        const actions = Array.isArray(b) ? b : (b.actions || b.steps || []);
        if (!actions.length) return json(res, 400, { ok: false, error: 'actions[] chahiye, e.g. {"actions":[{"action":"navigate","url":"https://example.com"},{"action":"extract"}]}' });
        try {
          const result = await chromium.runTask(actions, b);
          return json(res, result.ok ? 200 : 400, result);
        } catch (e) {
          return json(res, 503, { ok: false, error: e.message });
        }
      }

      // ---- session level ----
      const id = rest[0];
      const sub = rest[1] || '';

      if (sub === 'stream') {
        // SSE: screencast frames + nav/action events
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no'
        });
        const session = chromium.getSession(id);
        const send = (obj) => { try { res.write('data: ' + JSON.stringify(obj) + '\n\n'); } catch (e) {} };
        if (!session) { send({ type: 'error', error: 'session not found' }); return res.end(); }
        send({ type: 'hello', sessionId: id, viewport: session.viewport });
        if (session.lastFrame) send({ type: 'frame', jpeg: session.lastFrame, meta: session.frameMeta, ts: session.lastFrameAt });
        let last = 0;
        const onFrame = (s) => {
          if (s.id !== id) return;
          const now = Date.now();
          if (now - last < 80) return;           // ~12fps se zyada nahi
          last = now;
          send({ type: 'frame', jpeg: s.lastFrame, meta: s.frameMeta, ts: s.lastFrameAt });
        };
        const onNav = () => send({ type: 'nav', url: session.url, title: session.title });
        const onClose = () => { send({ type: 'closed' }); cleanup(); };
        const onDisconnect = () => { send({ type: 'browser-closed' }); cleanup(); };
        function cleanup() {
          chromium.off('frame', onFrame);
          session.off('nav', onNav);
          session.off('closed', onClose);
          chromium.off('browser-disconnected', onDisconnect);
          try { res.end(); } catch (e) {}
        }
        chromium.on('frame', onFrame);
        session.on('nav', onNav);
        session.on('closed', onClose);
        chromium.on('browser-disconnected', onDisconnect);
        const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 20000);
        req.on('close', () => { clearInterval(ping); cleanup(); });
        return;
      }

      if (sub === 'frame') {
        return withSession(async (session) => {
          await chromium.refreshFrame(session);
          if (!session.lastFrame) return { ok: false, error: 'frame abhi nahi aaya, thoda wait karo' };
          return { ok: true, jpeg: session.lastFrame, meta: session.frameMeta, ts: session.lastFrameAt, url: session.url, title: session.title };
        });
      }

      if (sub === 'screenshot') {
        const session = chromium.getSession(id);
        if (!session) return json(res, 404, { ok: false, error: 'session not found: ' + id });
        try {
          const shot = await chromium.screenshot(session, { full: q.full === '1', type: q.type, quality: q.quality });
          res.writeHead(200, { 'content-type': shot.contentType, 'cache-control': 'no-store', 'content-length': shot.buffer.length });
          return res.end(shot.buffer);   // binary response: json() yahan nahi chalega
        } catch (e) {
          return json(res, 500, { ok: false, error: e.message });
        }
      }

      if (sub === 'state' || (!sub && req.method === 'GET')) {
        return withSession(async (session) => await chromium.snapshot(session, { limit: Number(q.limit) || 0, elements: q.elements === 'none' ? false : 'all' }));
      }

      if (sub === 'extract') {
        return withSession(async (session) => await chromium.extract(session));
      }

      if (sub === 'navigate' && req.method === 'POST') {
        const b = await parseBody(req);
        return withSession(async (session) => await chromium.goto(session, b.url || q.url, b));
      }

      if (sub === 'act' && req.method === 'POST') {
        const b = await parseBody(req);
        const action = String(b.action || b.op || '').toLowerCase();
        return withSession(async (session) => {
          switch (action) {
            case 'click': return await chromium.click(session, b);
            case 'type': case 'fill': return await chromium.type(session, b);
            case 'press': case 'key': return await chromium.press(session, b);
            case 'scroll': return await chromium.scroll(session, b);
            case 'eval': return await chromium.evalJs(session, b.code || b.value);
            case 'extract': case 'read': return await chromium.extract(session);
            case 'screenshot': { const s2 = await chromium.screenshot(session, b); return { ok: true, bytes: s2.buffer.length, url: '/api/browser/' + session.id + '/screenshot' }; }
            case 'navigate': case 'goto': return await chromium.goto(session, b.url || b.value, b);
            case 'back': return await chromium.back(session);
            case 'forward': return await chromium.forward(session);
            case 'reload': return await chromium.reload(session);
            case 'state': case 'snapshot': return await chromium.snapshot(session, { elements: 'all' });
            default: return { ok: false, error: 'unknown action: ' + action, actions: ['click', 'type', 'press', 'scroll', 'eval', 'extract', 'screenshot', 'navigate', 'back', 'forward', 'reload', 'state'] };
          }
        });
      }

      // direct verbs: /api/browser/<id>/click  etc.
      const verbs = {
        click: (s, b) => chromium.click(s, b),
        type: (s, b) => chromium.type(s, b),
        fill: (s, b) => chromium.type(s, b),
        press: (s, b) => chromium.press(s, b),
        key: (s, b) => chromium.press(s, b),
        scroll: (s, b) => chromium.scroll(s, b),
        eval: (s, b) => chromium.evalJs(s, b.code || b.value),
        back: (s) => chromium.back(s),
        forward: (s) => chromium.forward(s),
        reload: (s) => chromium.reload(s)
      };
      if (verbs[sub] && req.method === 'POST') {
        const b = await parseBody(req);
        return withSession(async (session) => await verbs[sub](session, b));
      }

      if (sub === 'close' || (!sub && req.method === 'DELETE')) {
        const ok = await chromium.closeSession(id);
        return json(res, ok ? 200 : 404, { ok, closed: id });
      }

      return json(res, 404, { ok: false, error: 'unknown browser endpoint: ' + pathname, hint: 'GET /api/browser/status dekho' });
    }

    /* ---------------- docs ---------------- */
    if (pathname === '/api/meta') {
      return json(res, 200, {
        name: 'WebOS', version: VERSION,
        apps: shell.APPS,
        chromium: { running: !!(chromium.browser && chromium.browser.connected), sessions: chromium.sessions.size },
        endpoints: {
          chromium: 'POST /api/browser (new session) · POST /api/browser/task {actions} · GET /api/browser/status · POST /api/browser/<id>/act/state/screenshot/frame/extract/stream',
          chromiumOps: 'POST /api/agent/cmd {op:"chromium.open|goto|act|task|screenshot|frame|status|close", args:{...}}',
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
    if (res.headersSent || res.writableEnded) {
      console.error('[webos] handler error after response:', err && err.message);
      try { res.end(); } catch (e) {}
      return;
    }
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

/* ek bhi bug poore OS (aur agent ke browser session) ko na gire — log karo aur chalta raho */
process.on('uncaughtException', (err) => {
  console.error('[webos] uncaught exception:', err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n') : err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[webos] unhandled rejection:', reason && reason.message ? reason.message : reason);
});

process.on('SIGTERM', async () => { try { await chromium.closeAll(); } catch (e) {} process.exit(0); });
process.on('SIGINT', async () => { try { await chromium.closeAll(); } catch (e) {} process.exit(0); });

// keep SSE pipes alive
setInterval(() => { for (const [, c] of bus.clients) { try { c.res.write(': ka\n\n'); } catch (e) {} } }, 25000);
