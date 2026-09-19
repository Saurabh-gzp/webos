'use strict';
/**
 * Virtual File System for WebOS
 * Tree stored as JSON on disk (data/fs.json). Simple, agent friendly.
 *
 * Node shape:
 *   dir  : { type:'dir',  name, children:{ [name]: node }, created, modified }
 *   file : { type:'file', name, content:'', created, modified }
 */
const fs = require('fs');
const path = require('path');

// Data location is configurable so hosts can mount a persistent disk
// (e.g. Render disk at /var/data, Fly volume at /data).
const DATA_DIR = process.env.WEBOS_DATA_DIR
  ? path.resolve(process.env.WEBOS_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const FS_FILE = path.join(DATA_DIR, 'fs.json');

let root = null;

function now() { return Date.now(); }

function fileNode(name, content = '') {
  return { type: 'file', name, content, created: now(), modified: now() };
}
function dirNode(name) {
  return { type: 'dir', name, children: {}, created: now(), modified: now() };
}

function seed() {
  const r = dirNode('');
  r.children.Home = dirNode('Home');
  r.children.Home.children.Documents = dirNode('Documents');
  r.children.Home.children.Downloads = dirNode('Downloads');
  r.children.Home.children.Projects = dirNode('Projects');
  r.children.Home.children.Pictures = dirNode('Pictures');

  r.children.Home.children.Documents.children['welcome.txt'] = fileNode(
    'welcome.txt',
    [
      'Welcome to WebOS 1.0',
      '====================',
      '',
      'Ye ek browser-based operating system hai jo Agents ke liye banaya gaya hai.',
      '',
      'Sab kuch browser me chalta hai:',
      '  - Browser app   : real websites browse karo (server-side proxy)',
      '  - Files app     : ye virtual file system',
      '  - Terminal app  : ls, cd, cat, mkdir, echo, open, browse ...',
      '  - Agent Console : agent ki activity live dekho',
      '',
      'Agent kya kar sakta hai? AGENT.md padho ya Terminal me `help` chalao.',
      ''
    ].join('\n')
  );

  r.children.Home.children['AGENT.md'] = fileNode(
    'AGENT.md',
    [
      '# WebOS — Agent guide (iskai andar wala copy)',
      '',
      'Agent ke liye 3 cheezein kaafi hain:',
      '  1. GET  /api/agent/state            — poora OS state (windows, browser page, elements)',
      '  2. POST /api/agent/cmd {op,app,args} — kuch bhi karao (wait:true se result milta hai)',
      '  3. POST /api/exec {cmd}             — shell command (ls, mkdir, write, cat, ...)',
      '',
      'Zaroori ops:',
      '  open       {app:"browser"|"files"|"editor"|"terminal"|"docs"|"monitor"|"calc"|"music"|"agent"}',
      '  navigate   {url:"https://..."}      browser me site kholo',
      '  search     {q:"..."}                web search (structured results return karta hai)',
      '  read       {mode:"auto|text|elements"}   page padho, interactive elements ke refs lo',
      '  click      {ref:12} ya {text:"Sign in"}',
      '  type       {ref:3,text:"hello",submit:true}   ya {field:0,text:"hi"}',
      '  scroll     {y:800} ya {y:"bottom"}',
      '  extract    {url:"https://..."}      bina page kholne URL ka text (server-side)',
      '  shell      {cmd:"mkdir /Home/x && ls /Home/x"}',
      '  edit       {text:"...", save:true}  editor me likho (app:"editor")',
      '  notify     {text:"kaam ho gaya", kind:"ok"}',
      '  theme      {mode:"light", accent:"#35d07f"}',
      '  wallpaper  {css:"linear-gradient(160deg,#0f3d2e,#05100c)"}',
      '',
      'Windows ke ops: close, focus, minimize, maximize, restore, move {left,top,width,height}',
      'Browser ke ops: back, forward, reload, home, links, inputs, press, eval, tabs, newtab, closetab, switchtab, panel',
      '',
      'Poora reference: workspace ki AGENT-API.md file.',
      ''
    ].join('\n')
  );

  r.children.Home.children.Documents.children['agent-quickstart.md'] = fileNode(
    'agent-quickstart.md',
    [
      '# Agent Quickstart',
      '',
      'HTTP API (har endpoint CORS enabled hai):',
      '',
      '  GET  /api/agent/state            -> poora OS state (windows + page tree)',
      '  POST /api/agent/cmd              -> command bhejo (wait=1 se result milega)',
      '  POST /api/exec                   -> terminal command chalao',
      '  GET  /api/fs/list?path=/Home     -> files dekho',
      '  POST /api/fs/write               -> file likho',
      '  GET  /api/proxy/text?url=...     -> kisi bhi page ka text (reader mode)',
      '',
      'Example:',
      '  curl -s localhost:3000/api/agent/cmd -H "content-type: application/json" \\',
      '    -d \'{"op":"open","app":"browser","args":{"url":"https://example.com"},"wait":true}\'',
      ''
    ].join('\n')
  );

  r.children.Home.children.Projects.children['notes.txt'] = fileNode(
    'notes.txt',
    'TODO:\n- [ ] Agent se browser automate karwao\n- [ ] Naya app banao\n'
  );

  r.children.Home.children.Pictures.children['README.txt'] = fileNode(
    'README.txt',
    'Pictures folder khaali hai. Editor app se text files banao.\n'
  );

  return r;
}

function load() {
  if (root) return root;
  try {
    if (fs.existsSync(FS_FILE)) {
      root = JSON.parse(fs.readFileSync(FS_FILE, 'utf8'));
      if (!root || root.type !== 'dir') root = seed();
    } else {
      root = seed();
      save();
    }
  } catch (e) {
    root = seed();
  }
  return root;
}

function save() {
  if (!root) return;
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FS_FILE, JSON.stringify(root, null, 1));
  } catch (e) { /* ignore */ }
}

/** Normalize "/a//b/.." -> ["a","b"] */
function parts(p) {
  if (!p || typeof p !== 'string') return [];
  return p.split('/').map(s => s.trim()).filter(s => s && s !== '.');
}

function get(pathStr) {
  const r = load();
  const ps = parts(pathStr);
  let node = r;
  for (const part of ps) {
    if (!node || node.type !== 'dir') return null;
    if (part === '..') continue;
    node = node.children[part];
  }
  return node || null;
}

function parentOf(pathStr) {
  const ps = parts(pathStr);
  if (!ps.length) return { parent: null, name: null };
  const name = ps[ps.length - 1];
  const parentPath = '/' + ps.slice(0, -1).join('/');
  return { parent: get(parentPath), name };
}

function normalize(pathStr) {
  return '/' + parts(pathStr).join('/');
}

const API = {
  root: load,

  list(pathStr) {
    const node = get(pathStr);
    if (!node) return { error: 'no such directory: ' + pathStr };
    if (node.type === 'file') return { error: 'not a directory: ' + pathStr };
    const entries = Object.values(node.children).map(n => ({
      name: n.name,
      type: n.type,
      size: n.type === 'file' ? (n.content || '').length : Object.keys(n.children).length,
      modified: n.modified
    }));
    entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : (a.type === 'dir' ? -1 : 1)));
    return { path: normalize(pathStr), entries };
  },

  read(pathStr) {
    const node = get(pathStr);
    if (!node) return { error: 'no such file: ' + pathStr };
    if (node.type !== 'file') return { error: 'is a directory: ' + pathStr };
    const out = {
      path: normalize(pathStr),
      content: node.content || '',
      size: node.binary ? Number(node.size) || 0 : (node.content || '').length,
      modified: node.modified
    };
    if (node.binary) {
      out.binary = true;
      out.mime = node.mime || 'application/octet-stream';
      out.dataUrl = 'data:' + out.mime + ';base64,' + (node.content || '');
      out.content = '[binary ' + out.mime + ', ' + out.size + ' bytes] ' + normalize(pathStr);
    }
    return out;
  },

  write(pathStr, content, opts = {}) {
    const ps = parts(pathStr);
    if (!ps.length) return { error: 'invalid path' };
    const name = ps[ps.length - 1];
    const dirPath = '/' + ps.slice(0, -1).join('/');
    let dir = get(dirPath);
    if (!dir || dir.type !== 'dir') {
      if (!opts.createParents) return { error: 'no such directory: ' + dirPath };
      API.mkdir(dirPath, true);
      dir = get(dirPath);
    }
    const existing = dir.children[name];
    if (existing && existing.type === 'dir') return { error: 'is a directory: ' + pathStr };
    if (existing) {
      existing.content = String(content == null ? '' : content);
      existing.modified = now();
      save();
      return { ok: true, path: normalize(pathStr), bytes: existing.content.length, action: 'updated' };
    }
    dir.children[name] = fileNode(name, String(content == null ? '' : content));
    dir.modified = now();
    save();
    return { ok: true, path: normalize(pathStr), bytes: dir.children[name].content.length, action: 'created' };
  },

  /** Binary file (screenshots, downloads) — base64 me store hota hai, /api/fs/raw se serve hota hai */
  writeBinary(pathStr, buffer, opts = {}) {
    const b64 = Buffer.isBuffer(buffer) ? buffer.toString('base64') : String(buffer || '');
    const mime = opts.mime || (b64.startsWith('/9j/') ? 'image/jpeg' : b64.startsWith('iVBOR') ? 'image/png' : 'application/octet-stream');
    const res = API.write(pathStr, b64, opts);
    if (res.error) return res;
    const node = get(pathStr);
    if (node) { node.binary = true; node.mime = mime; node.size = Buffer.isBuffer(buffer) ? buffer.length : Math.floor(b64.length * 0.75); save(); }
    return Object.assign({}, res, { binary: true, mime });
  },

  /** Binary file ka raw Buffer (server /api/fs/raw ke liye) */
  readBinary(pathStr) {
    const node = get(pathStr);
    if (!node || node.type !== 'file' || !node.binary) return { error: 'not a binary file: ' + pathStr };
    return { path: normalize(pathStr), mime: node.mime || 'application/octet-stream', buffer: Buffer.from(node.content || '', 'base64'), size: Number(node.size) || 0 };
  },

  /** Append text (used by agents/logs) */
  append(pathStr, content) {
    const r = API.read(pathStr);
    if (r.error) return API.write(pathStr, String(content), { createParents: true });
    return API.write(pathStr, (r.content || '') + String(content));
  },

  mkdir(pathStr, createParents = false) {
    const ps = parts(pathStr);
    if (!ps.length) return { error: 'invalid path' };
    let node = get('/');
    for (let i = 0; i < ps.length; i++) {
      const name = ps[i];
      const isLast = i === ps.length - 1;
      if (!node.children[name]) {
        if (!isLast && !createParents) {
          const missing = '/' + ps.slice(0, i + 1).join('/');
          return { error: 'no such directory: ' + missing };
        }
        node.children[name] = dirNode(name);
      } else if (node.children[name].type !== 'dir') {
        return { error: 'not a directory: /' + ps.slice(0, i + 1).join('/') };
      }
      node = node.children[name];
    }
    node.modified = now();
    save();
    return { ok: true, path: normalize(pathStr), action: 'created' };
  },

  rm(pathStr, recursive = false) {
    const { parent, name } = parentOf(pathStr);
    if (!parent || !name) return { error: 'cannot remove root' };
    const node = parent.children[name];
    if (!node) return { error: 'no such file or directory: ' + pathStr };
    if (node.type === 'dir' && !recursive && Object.keys(node.children).length) {
      return { error: 'directory not empty (use rm -r): ' + pathStr };
    }
    delete parent.children[name];
    save();
    return { ok: true, path: normalize(pathStr), action: 'removed' };
  },

  move(from, to) {
    const src = get(from);
    if (!src) return { error: 'no such file: ' + from };
    if (from === '/' || to === '/') return { error: 'cannot move root' };
    if (normalize(to).startsWith(normalize(from) + '/')) return { error: 'cannot move into itself' };
    const dst = get(to);
    if (dst && dst.type === 'dir') {
      const name = parts(from).pop();
      if (dst.children[name]) return { error: 'already exists: ' + to + '/' + name };
      dst.children[name] = src;
      dst.modified = now();
    } else {
      const { parent, name: dstName } = parentOf(to);
      if (!parent) return { error: 'bad destination: ' + to };
      if (parent.children[dstName]) return { error: 'already exists: ' + to };
      src.name = dstName;
      parent.children[dstName] = src;
      parent.modified = now();
    }
    const { parent: sp, name: sname } = parentOf(from);
    if (sp && sname) delete sp.children[sname];
    save();
    return { ok: true, from: normalize(from), to: normalize(to), action: 'moved' };
  },

  copy(from, to) {
    const src = get(from);
    if (!src) return { error: 'no such file: ' + from };
    const clone = JSON.parse(JSON.stringify(src));
    const dst = get(to);
    if (dst && dst.type === 'dir') {
      const name = parts(from).pop();
      dst.children[name] = clone;
      clone.name = name;
      dst.modified = now();
    } else {
      const { parent, name: dstName } = parentOf(to);
      if (!parent) return { error: 'bad destination: ' + to };
      clone.name = dstName;
      parent.children[dstName] = clone;
      parent.modified = now();
    }
    save();
    return { ok: true, from: normalize(from), to: normalize(to), action: 'copied' };
  },

  tree(pathStr = '/', depth = 3) {
    const node = get(pathStr);
    if (!node) return { error: 'no such path: ' + pathStr };
    const walk = (n, d, prefix) => {
      const out = [];
      if (n.type === 'file') {
        out.push({ path: prefix + n.name, type: 'file', size: (n.content || '').length });
        return out;
      }
      if (d > 0) {
        for (const name of Object.keys(n.children).sort()) {
          out.push(...walk(n.children[name], d - 1, prefix + n.name + '/'));
        }
      }
      return out;
    };
    return { path: normalize(pathStr), entries: walk(node, depth, '') };
  },

  /** naive content search */
  search(query, pathStr = '/') {
    const needle = String(query || '').toLowerCase();
    const hits = [];
    const node = get(pathStr);
    if (!node) return { error: 'no such path: ' + pathStr };
    const walk = (n, prefix) => {
      if (n.type === 'file') {
        const idx = (n.content || '').toLowerCase().indexOf(needle);
        if (idx >= 0) {
          hits.push({
            path: prefix + n.name,
            line: (n.content || '').slice(0, idx).split('\n').length,
            snippet: (n.content || '').slice(Math.max(0, idx - 40), idx + 80).replace(/\n/g, ' ')
          });
        }
        return;
      }
      for (const name of Object.keys(n.children)) walk(n.children[name], prefix + n.name + '/');
    };
    walk(node, '/');
    return { query, hits, count: hits.length };
  },

  stats() {
    const r = load();
    let files = 0, dirs = 0, bytes = 0;
    const walk = (n) => {
      if (n.type === 'file') { files++; bytes += (n.content || '').length; return; }
      dirs++;
      Object.values(n.children).forEach(walk);
    };
    walk(r);
    return { files, dirs, bytes };
  },

  reset() { root = seed(); save(); return { ok: true, action: 'reset' }; }
};

module.exports = API;
