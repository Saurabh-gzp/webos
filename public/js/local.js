/* ============================================================
   local.js — WebOS "local mode"
   ------------------------------------------------------------
   Activates only when window.WEBOS_LOCAL === true (single-file build).
   It gives the OS a complete client-side backend so the UI works with
   NO server at all: virtual filesystem (localStorage), shell, agent bus
   and status endpoints. It installs a fetch() shim that answers /api/*
   requests locally, so none of the app code had to change.
   ============================================================ */
(function () {
  'use strict';
  if (!window.WEBOS_LOCAL) return;

  const LS_FS = 'webos.local.fs';
  const VERSION = '1.0.0-local';

  /* ---------------- virtual filesystem ---------------- */
  const now = () => Date.now();
  const fileNode = (name, content = '') => ({ type: 'file', name, content, created: now(), modified: now() });
  const dirNode = (name) => ({ type: 'dir', name, children: {}, created: now(), modified: now() });

  function seed() {
    const r = dirNode('');
    r.children.Home = dirNode('Home');
    const H = r.children.Home;
    H.children.Documents = dirNode('Documents');
    H.children.Downloads = dirNode('Downloads');
    H.children.Projects = dirNode('Projects');
    H.children.Pictures = dirNode('Pictures');
    H.children['AGENT.md'] = fileNode('AGENT.md', [
      '# WebOS — local mode',
      '',
      'Ye single-file build hai: poora OS browser ke andar hi chalta hai.',
      '',
      'Kaam karta hai:',
      '  - window manager, saare apps, themes, notifications',
      '  - virtual filesystem (browser ke localStorage me persist)',
      '  - shell (ls, cd, cat, mkdir, write, open, theme, notify ...)',
      '  - agent commands: console me chalao —',
      '      WebOS.handleCommand({op:"open",app:"files"})',
      '      WebOS.handleCommand({op:"shadow", app:"browser", args:{url:"https://example.com"}})',
      '',
      'Server mode (node server.js) me extra milta hai:',
      '  - real web proxy (kisi bhi site ko OS browser me kholna)',
      '  - page padhna / click / type (agent refs)',
      '  - multi-engine web search',
      '  - agent ke liye HTTP API: /api/agent/cmd, /api/agent/state',
      ''
    ].join('\n'));
    H.children.Documents.children['welcome.txt'] = fileNode('welcome.txt',
      'Welcome to WebOS (local mode)\n\nYe file browser ke localStorage me hai — refresh ke baad bhi rahegi.\n');
    H.children.Documents.children['agent-quickstart.md'] = fileNode('agent-quickstart.md',
      '# Agent quickstart (local mode)\n\nConsole me:\n  WebOS.handleCommand({op:"open",app:"browser",args:{url:"https://example.com"}})\n  WebOS.handleCommand({op:"theme",args:{mode:"light"}})\n  WebOS.handleCommand({op:"read"})\n');
    H.children.Projects.children['notes.txt'] = fileNode('notes.txt', 'TODO:\n- [ ] server deploy karo (proxy + agent API ke liye)\n');
    H.children.Pictures.children['README.txt'] = fileNode('README.txt', 'Pictures folder khaali hai.\n');
    return r;
  }

  let root = null;
  function load() {
    if (root) return root;
    try {
      const raw = localStorage.getItem(LS_FS);
      if (raw) { root = JSON.parse(raw); if (!root || root.type !== 'dir') root = seed(); }
      else { root = seed(); save(); }
    } catch (e) { root = seed(); }
    return root;
  }
  function save() { try { localStorage.setItem(LS_FS, JSON.stringify(root)); } catch (e) {} }
  const parts = (p) => String(p || '').split('/').map(s => s.trim()).filter(s => s && s !== '.');
  const normalize = (p) => '/' + parts(p).join('/');

  function get(pathStr) {
    let node = load();
    for (const part of parts(pathStr)) {
      if (!node || node.type !== 'dir') return null;
      node = node.children[part];
      if (!node) return null;
    }
    return node;
  }
  function parentOf(pathStr) {
    const ps = parts(pathStr);
    if (!ps.length) return { parent: null, name: null };
    return { parent: get('/' + ps.slice(0, -1).join('/')), name: ps[ps.length - 1] };
  }

  const vfs = {
    list(pathStr) {
      const n = get(pathStr);
      if (!n) return { error: 'no such directory: ' + pathStr };
      if (n.type !== 'dir') return { error: 'not a directory: ' + pathStr };
      const entries = Object.values(n.children).map(x => ({
        name: x.name, type: x.type,
        size: x.type === 'file' ? (x.content || '').length : Object.keys(x.children).length,
        modified: x.modified
      })).sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : (a.type === 'dir' ? -1 : 1)));
      return { path: normalize(pathStr), entries };
    },
    read(pathStr) {
      const n = get(pathStr);
      if (!n) return { error: 'no such file: ' + pathStr };
      if (n.type !== 'file') return { error: 'is a directory: ' + pathStr };
      return { path: normalize(pathStr), content: n.content || '', size: (n.content || '').length, modified: n.modified };
    },
    write(pathStr, content) {
      const ps = parts(pathStr);
      if (!ps.length) return { error: 'invalid path' };
      const dirPath = '/' + ps.slice(0, -1).join('/');
      let dir = get(dirPath);
      if (!dir || dir.type !== 'dir') { vfs.mkdir(dirPath, true); dir = get(dirPath); }
      if (!dir) return { error: 'no such directory: ' + dirPath };
      const name = ps[ps.length - 1];
      const ex = dir.children[name];
      if (ex && ex.type === 'dir') return { error: 'is a directory: ' + pathStr };
      if (ex) { ex.content = String(content == null ? '' : content); ex.modified = now(); }
      else dir.children[name] = fileNode(name, content);
      dir.modified = now(); save();
      return { ok: true, path: normalize(pathStr), bytes: String(content || '').length, action: ex ? 'updated' : 'created' };
    },
    mkdir(pathStr, createParents) {
      const ps = parts(pathStr);
      let node = load();
      for (let i = 0; i < ps.length; i++) {
        const name = ps[i];
        if (!node.children[name]) {
          if (i !== ps.length - 1 && !createParents) return { error: 'no such directory: /' + ps.slice(0, i + 1).join('/') };
          node.children[name] = dirNode(name);
        } else if (node.children[name].type !== 'dir') return { error: 'not a directory: /' + ps.slice(0, i + 1).join('/') };
        node = node.children[name];
      }
      save();
      return { ok: true, path: normalize(pathStr), action: 'created' };
    },
    rm(pathStr, recursive) {
      const { parent, name } = parentOf(pathStr);
      if (!parent || !name) return { error: 'cannot remove root' };
      const node = parent.children[name];
      if (!node) return { error: 'no such file or directory: ' + pathStr };
      if (node.type === 'dir' && !recursive && Object.keys(node.children).length) return { error: 'directory not empty (use rm -r)' };
      delete parent.children[name]; save();
      return { ok: true, path: normalize(pathStr), action: 'removed' };
    },
    move(from, to, copy) {
      const src = get(from);
      if (!src) return { error: 'no such file: ' + from };
      const clone = JSON.parse(JSON.stringify(src));
      const dst = get(to);
      const name = parts(to).pop();
      if (dst && dst.type === 'dir') { dst.children[parts(from).pop()] = clone; dst.modified = now(); }
      else {
        const { parent, name: dn } = parentOf(to);
        if (!parent) return { error: 'bad destination: ' + to };
        clone.name = dn; parent.children[dn] = clone; parent.modified = now();
      }
      if (!copy) { const { parent: sp, name: sn } = parentOf(from); if (sp && sn) delete sp.children[sn]; }
      save();
      return { ok: true, from: normalize(from), to: normalize(to), action: copy ? 'copied' : 'moved' };
    },
    tree(pathStr, depth) {
      const n = get(pathStr || '/');
      if (!n) return { error: 'no such path: ' + pathStr };
      const out = [];
      const walk = (node, d, prefix) => {
        if (node.type === 'file') { out.push({ path: prefix + node.name, type: 'file', size: (node.content || '').length }); return; }
        if (d > 0) Object.keys(node.children).sort().forEach(k => walk(node.children[k], d - 1, prefix + node.name + '/'));
      };
      walk(n, depth || 3, '');
      return { path: normalize(pathStr), entries: out };
    },
    search(query, pathStr) {
      const needle = String(query || '').toLowerCase();
      const hits = [];
      const walk = (n, prefix) => {
        if (n.type === 'file') {
          const idx = (n.content || '').toLowerCase().indexOf(needle);
          if (idx >= 0) hits.push({ path: prefix + n.name, line: (n.content || '').slice(0, idx).split('\n').length, snippet: (n.content || '').slice(Math.max(0, idx - 40), idx + 80).replace(/\n/g, ' ') });
          return;
        }
        Object.keys(n.children).forEach(k => walk(n.children[k], prefix + n.name + '/'));
      };
      walk(get(pathStr || '/') || load(), '/');
      return { query, hits, count: hits.length };
    },
    stats() {
      let files = 0, dirs = 0, bytes = 0;
      const walk = (n) => { if (n.type === 'file') { files++; bytes += (n.content || '').length; return; } dirs++; Object.values(n.children).forEach(walk); };
      walk(load());
      return { files, dirs, bytes };
    }
  };

  /* ---------------- shell ---------------- */
  const HELP = `WebOS Shell (local mode)
  help  ls [path]  cd <path>  pwd  cat <file>
  echo "text" [> file]   write <file> "text"   mkdir <dir>   touch <file>
  rm [-r] <path>  cp <src> <dst>  mv <src> <dst>  tree [path]  find <text>
  open <app>   browse <url>   apps   windows   sysinfo   date   whoami   clear
  theme <dark|light>   wallpaper <css>

Server mode (node server.js) me extra: read <url>, search <query>, agent <op>`;

  function tokenize(line) {
    const out = []; let cur = '', q = null;
    for (const c of line) {
      if (q) { if (c === q) q = null; else cur += c; }
      else if (c === '"' || c === "'") q = c;
      else if (/\s/.test(c)) { if (cur) { out.push(cur); cur = ''; } }
      else cur += c;
    }
    if (cur) out.push(cur);
    return out;
  }
  function joinPath(cwd, p) {
    if (!p) return cwd;
    if (p.startsWith('/')) return '/' + parts(p).join('/');
    const base = parts(cwd);
    for (const part of parts(p)) { if (part === '..') base.pop(); else base.push(part); }
    return '/' + base.join('/');
  }
  const histories = [];

  async function run(cmdLine, cwd, isSub) {
    cwd = cwd || '/Home';
    const raw = String(cmdLine || '').trim();
    if (!raw) return { out: '', cwd, code: 0 };
    if (!isSub) histories.push(raw);

    // chaining:  a && b   |   a ; b
    const chain = raw.split(/\s*(?:&&|;)\s*/).filter(Boolean);
    if (chain.length > 1) {
      let outs = [], cur = cwd, code = 0;
      for (const part of chain) {
        const r = await run(part, cur, true);
        cur = r.cwd; code = r.code;
        if (r.out) outs.push(r.out);
        if (code !== 0) break;
      }
      return { out: outs.join('\n'), cwd: cur, code };
    }

    let redirect = null;
    const rm = /\s(>>?)\s*(\S+)\s*$/.exec(raw);
    let line = raw;
    if (rm) { redirect = { mode: rm[1], path: joinPath(cwd, rm[2]) }; line = raw.slice(0, rm.index).trim(); }
    const t = tokenize(line);
    const cmd = (t.shift() || '').toLowerCase();
    const rest = t.join(' ');

    const done = (out, code) => {
      out = out == null ? '' : String(out);
      if (redirect) {
        if (redirect.mode === '>>') { const r = vfs.read(redirect.path); vfs.write(redirect.path, ((r.content || '') + out + '\n')); }
        else vfs.write(redirect.path, out + '\n');
        return { out: '', cwd, code: code || 0 };
      }
      return { out, cwd, code: code || 0 };
    };
    const APPS = ['browser', 'files', 'editor', 'terminal', 'agent', 'calc', 'settings', 'docs', 'monitor', 'music'];

    switch (cmd) {
      case 'help': case '?': return done(HELP);
      case 'pwd': return done(cwd);
      case 'ls': case 'dir': {
        const r = vfs.list(joinPath(cwd, t[0] || ''));
        if (r.error) return done(r.error, 1);
        return done(r.entries.map(e => (e.type === 'dir' ? 'd ' : '- ') + e.name.padEnd(28) + (e.type === 'dir' ? '<DIR>' : e.size + ' b')).join('\n') || '(empty)');
      }
      case 'cd': {
        const target = joinPath(cwd, t[0] || '/');
        const r = vfs.list(target);
        if (r.error) return done(r.error, 1);
        return { out: '', cwd: r.path, code: 0 };
      }
      case 'cat': {
        if (!t[0]) return done('usage: cat <file>', 1);
        const r = vfs.read(joinPath(cwd, t[0]));
        return done(r.error || r.content, r.error ? 1 : 0);
      }
      case 'echo': return done(rest.replace(/^["']|["']$/g, ''));
      case 'write': {
        if (t.length < 2) return done('usage: write <file> <text>', 1);
        const r = vfs.write(joinPath(cwd, t[0]), t.slice(1).join(' ') + '\n');
        return done(r.error || ('written ' + r.bytes + ' bytes -> ' + r.path), r.error ? 1 : 0);
      }
      case 'mkdir': {
        const r = vfs.mkdir(joinPath(cwd, t[0] || ''), true);
        return done(r.error || '', r.error ? 1 : 0);
      }
      case 'touch': { const p = joinPath(cwd, t[0] || ''); if (vfs.read(p).error) vfs.write(p, ''); return done(''); }
      case 'rm': case 'del': {
        const rec = t[0] === '-r' || t[0] === '-rf';
        const r = vfs.rm(joinPath(cwd, t[rec ? 1 : 0] || ''), rec);
        return done(r.error || ('removed ' + r.path), r.error ? 1 : 0);
      }
      case 'cp': case 'mv': {
        if (t.length < 2) return done('usage: ' + cmd + ' <src> <dst>', 1);
        const r = vfs.move(joinPath(cwd, t[0]), joinPath(cwd, t[1]), cmd === 'cp');
        return done(r.error || '', r.error ? 1 : 0);
      }
      case 'tree': {
        const r = vfs.tree(joinPath(cwd, t[0] || ''), 3);
        return done(r.error || r.entries.map(e => (e.type === 'dir' ? '[D] ' : '    ') + e.path).join('\n') || '(empty)');
      }
      case 'find': case 'grep': {
        const r = vfs.search(t[0] || '', joinPath(cwd, t[1] || ''));
        return done(r.count ? r.hits.map(h => h.path + ':' + h.line + ': ' + h.snippet).join('\n') : 'no matches');
      }
      case 'date': return done(new Date().toString());
      case 'whoami': return done('agent');
      case 'uname': return done('WebOS ' + VERSION + ' (single-file, client-side)');
      case 'clear': return { out: '__CLEAR__', cwd, code: 0 };
      case 'apps': return done(APPS.join('\n'));
      case 'sysinfo': {
        const s = vfs.stats();
        return done(JSON.stringify({
          version: VERSION, mode: 'local', files: s.files, dirs: s.dirs, bytes: s.bytes,
          windows: (window.WebOS ? WebOS.windows.map(w => w.app + ':' + w.title) : []),
          online: navigator.onLine
        }, null, 2));
      }
      case 'windows': {
        const ws = window.WebOS ? WebOS.windows : [];
        return done(ws.length ? ws.map(w => `${w.focused ? '*' : ' '} [${w.id}] ${w.app} - ${w.title}`).join('\n') : 'no windows open');
      }
      case 'history': return done(histories.map((h, i) => String(i + 1).padStart(4) + '  ' + h).join('\n'));
      case 'open': {
        const app = (t[0] || '').toLowerCase();
        if (!APPS.includes(app)) return done('unknown app: ' + app + '\napps: ' + APPS.join(', '), 1);
        const args = t[1] ? { url: t[1], path: t[1], arg: t[1] } : {};
        const w = window.WebOS && WebOS.open(app, args);
        return done(w ? 'opened ' + app + ' [' + w.id + ']' : 'open failed', w ? 0 : 1);
      }
      case 'browse': {
        const url = t[0] || 'https://example.com';
        if (window.WebOS) WebOS.open('browser', { url });
        return done('browsing ' + url + '  (local mode: page OS iframe me khulti hai)');
      }
      case 'theme': {
        const mode = (t[0] || 'dark').toLowerCase();
        if (window.WebOS) WebOS.setTheme(mode);
        return done('theme: ' + mode);
      }
      case 'wallpaper': {
        if (window.WebOS) WebOS.setWallpaper(rest || null);
        return done('wallpaper updated');
      }
      case 'notify': {
        if (window.WebOS) WebOS.notify(rest || 'hello', 'ok');
        return done('notified');
      }
      case 'agent': {
        if (!window.WebOS) return done('os not ready', 1);
        const op = t[0] || 'state';
        if (op === 'state') return done(JSON.stringify(WebOS.state(), null, 2));
        let args = {};
        if (op === 'click') args = { ref: Number(t[1]) };
        else if (op === 'type') args = { ref: Number(t[1]), text: t.slice(2).join(' ') };
        else if (op === 'navigate') args = { url: t[1] };
        const res = await WebOS.handleCommand({ op, args, app: t[t.length - 1] });
        return done(JSON.stringify(res, null, 2));
      }
      case 'read':
      case 'search':
        return done('local mode me `' + cmd + '` nahi chalta — ye server (node server.js) ke proxy/search se aata hai.', 1);
      default:
        return done('command not found: ' + cmd + '  (try `help`)', 127);
    }
  }

  /* ---------------- agent log (in-page) ---------------- */
  const agentLog = [];
  let logSeq = 0;
  function pushLog(kind, text, extra) {
    const e = Object.assign({ seq: ++logSeq, ts: Date.now(), kind, text: String(text).slice(0, 400) }, extra || {});
    agentLog.push(e);
    if (agentLog.length > 400) agentLog.shift();
    return e;
  }
  pushLog('system', 'WebOS local mode started (single-file build)');

  /* ---------------- fetch shim ---------------- */
  function makeResponse(obj, status) {
    return {
      ok: (status || 200) < 400,
      status: status || 200,
      json: () => Promise.resolve(obj),
      text: () => Promise.resolve(typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2)),
      headers: { get: () => 'application/json' }
    };
  }

  async function route(pathname, query, init) {
    const body = init && init.body ? JSON.parse(init.body) : {};
    switch (pathname) {
      /* status */
      case '/api/ping': return makeResponse({ ok: true, version: VERSION, mode: 'local', clients: 0, ts: Date.now() });
      case '/api/meta': return makeResponse({
        name: 'WebOS (local mode)', version: VERSION, mode: 'local',
        apps: webosApps(), help: HELP,
        endpoints: { note: 'single-file build — koi server nahi chahiye' }
      });

      /* filesystem */
      case '/api/fs/list': return makeResponse(vfs.list(query.get('path') || '/'));
      case '/api/fs/read': return makeResponse(vfs.read(query.get('path') || ''));
      case '/api/fs/tree': return makeResponse(vfs.tree(query.get('path') || '/', Number(query.get('depth')) || 3));
      case '/api/fs/search': return makeResponse(vfs.search(query.get('q') || '', query.get('path') || '/'));
      case '/api/fs/stats': return makeResponse(vfs.stats());
      case '/api/fs/write': return makeResponse(body.action === 'append'
        ? (() => { const r = vfs.read(body.path || ''); return vfs.write(body.path || '', (r.content || '') + (body.content || '')); })()
        : vfs.write(body.path || '', body.content == null ? '' : body.content));
      case '/api/fs/mkdir': return makeResponse(vfs.mkdir(body.path || '', true));
      case '/api/fs/rm': return makeResponse(vfs.rm(body.path || '', body.recursive !== false));
      case '/api/fs/move': return makeResponse(vfs.move(body.from || '', body.to || '', !!body.copy));

      /* shell */
      case '/api/exec': return makeResponse(await run(body.cmd || body.command || '', body.cwd || '/Home'));

      /* agent bus (in-page) */
      case '/api/agent/state': {
        const st = (window.WebOS ? WebOS.state() : { windows: [] });
        return makeResponse(Object.assign({ connected: false, local: true, clients: 0, queueDepth: 0, ts: Date.now() }, st));
      }
      case '/api/agent/cmd': {
        const op = body.op || (body.cmd && body.cmd.op);
        const args = body.args || (body.cmd && body.cmd.args) || {};
        const app = body.app || (body.cmd && body.cmd.app);
        if (!op) return makeResponse({ ok: false, error: 'missing op' }, 400);
        if (!window.WebOS) return makeResponse({ ok: false, error: 'OS booting…' }, 503);
        pushLog('cmd', op + (app ? ' ' + app : ''), { args });
        const started = Date.now();
        try {
          const result = await WebOS.handleCommand({ op, app, args, id: 'local-' + logSeq });
          pushLog(result && result.ok === false ? 'error' : 'ok',
            op + (result && result.error ? ': ' + result.error : ''), { id: 'local-' + logSeq });
          const out = Object.assign({ ok: true, op, handledBy: result && result.handledBy || 'local', ms: Date.now() - started }, result || {});
          out.localNote = 'local mode: GUI commands chalte hain, web-proxy ops nahi.';
          return makeResponse(out);
        } catch (e) {
          pushLog('error', op + ': ' + e.message, {});
          return makeResponse({ ok: false, op, error: e.message }, 500);
        }
      }
      case '/api/agent/log': {
        const since = Number(query.get('since') || 0);
        return makeResponse({ log: agentLog.filter(e => e.seq > since), last: agentLog.length ? agentLog[agentLog.length - 1].seq : 0 });
      }
      case '/api/agent/inbox': return makeResponse({ commands: [] });
      case '/api/agent/report': case '/api/agent/result': return makeResponse({ ok: true });
      case '/api/agent/clients': return makeResponse({ clients: [], primary: null, local: true });

      /* web features need the server */
      case '/api/search': return makeResponse({ query: query.get('q') || '', engine: null, count: 0, results: [], errors: ['local mode: /api/search needs the Node server'] }, 200);
      case '/api/proxy': case '/api/proxy/raw': case '/api/proxy/text':
        return makeResponse({ error: 'local mode: web proxy needs the Node server (node server.js)', url: query.get('url') }, 501);

      default: return makeResponse({ error: 'not available in local mode: ' + pathname }, 404);
    }
  }

  let cachedApps = null;
  function webosApps() {
    try { return (window.WebOS ? WebOS.state().apps.map(a => a.id) : ['browser', 'files', 'editor', 'terminal', 'agent', 'calc', 'settings', 'docs', 'monitor', 'music']); }
    catch (e) { return ['browser', 'files', 'editor', 'terminal', 'agent', 'calc', 'settings', 'docs', 'monitor', 'music']; }
  }

  const origFetch = window.fetch ? window.fetch.bind(window) : null;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    let u = null;
    try { u = new URL(url, location.href); } catch (e) {}
    if (u && u.pathname.indexOf('/api/') === 0) {
      const q = u.searchParams;
      responseDelay(() => {});
      return route(u.pathname, q, init || {});
    }
    if (origFetch) return origFetch(input, init);
    return Promise.reject(new Error('offline (local mode)'));
  };
  function responseDelay() { /* keeps signatures tidy */ }

  /* expose for the console + tests */
  window.WebOSLocal = {
    version: VERSION,
    vfs,
    shell: (cmd, cwd) => run(cmd, cwd),
    log: () => agentLog.slice(),
    reset: () => { root = seed(); save(); pushLog('system', 'filesystem reset (local)'); return { ok: true }; }
  };
})();
