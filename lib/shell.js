'use strict';
/**
 * WebOS shell -- a small, safe command interpreter over the virtual FS.
 * GUI-aware commands (open / browse / notify / agent) are dispatched to the
 * connected browser client through the agent bus.
 */
const vfs = require('./vfs');

function join(cwd, p) {
  if (!p) return cwd;
  if (p.startsWith('/')) return '/' + p.split('/').filter(Boolean).join('/');
  if (p.startsWith('~')) return '/' + p.slice(1).split('/').filter(Boolean).join('/');
  const base = cwd.split('/').filter(Boolean);
  for (const part of p.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') base.pop();
    else base.push(part);
  }
  return '/' + base.join('/');
}

function tokenize(line) {
  const out = [];
  let cur = '', q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === q) q = null; else cur += c;
    } else if (c === '"' || c === "'") q = c;
    else if (/\s/.test(c)) { if (cur) { out.push(cur); cur = ''; } }
    else cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

const HELP = `WebOS Shell -- available commands
  help                 yeh list dikhao
  ls [path]            files list karo
  cd <path>            directory change karo
  pwd                  current path
  cat <file>           file padho
  write <text...> [> file] / echo <text> [> file]
  mkdir <dir>          naya folder
  touch <file>         khaali file
  rm [-r] <path>       delete
  cp <src> <dst>       copy
  mv <src> <dst>       move / rename
  tree [path]          folder tree
  find <text>          file content me search
  open <app> [arg]     GUI app kholo  (browser, files, editor, terminal, agent, calc, settings, docs)
  browse <url>         browser me website kholo
  read <url>           page ka text console me lao (reader mode)
  search <query>       web search karo
  agent <op> [json]    agent bus command bhejo (state / click / type / ...)
  windows              open windows ki list
  notify <text>        desktop notification
  wallpaper <css>      desktop wallpaper badlo (css gradient)
  apps                 installed apps
  sysinfo              system info
  history              command history
  clear                screen clear`;

const APPS = ['browser', 'files', 'editor', 'terminal', 'agent', 'calc', 'settings', 'docs', 'monitor', 'music'];

function createShell({ bus, proxy, version }) {
  const histories = new Map(); // sessionId -> [cmds]

  async function run(line, ctx = {}) {
    const sessionId = ctx.sessionId || 'default';
    let cwd = ctx.cwd || '/Home';
    const raw = String(line || '').trim();
    if (!raw) return { out: '', cwd, code: 0 };

    if (!histories.has(sessionId)) histories.set(sessionId, []);
    const hist = histories.get(sessionId);
    if (hist[hist.length - 1] !== raw) hist.push(raw);
    if (hist.length > 200) hist.shift();

    // support  a && b  and  a ; b
    const parts = raw.split(/\s*(?:&&|;)\s*/).filter(Boolean);
    if (parts.length > 1) {
      let outs = [];
      let cur = cwd;
      for (const p of parts) {
        const r = await run(p, { ...ctx, cwd: cur });
        cur = r.cwd;
        if (r.out) outs.push(r.out);
        if (r.code !== 0) return { out: outs.join('\n'), cwd: cur, code: r.code };
      }
      return { out: outs.join('\n'), cwd: cur, code: 0 };
    }

    // redirection: cmd > file  /  >> file
    let redirect = null;
    const redirMatch = /\s(>>?)\s*(\S+)\s*$/.exec(raw);
    let cmdLine = raw;
    if (redirMatch) {
      redirect = { mode: redirMatch[1], path: join(cwd, redirMatch[2]) };
      cmdLine = raw.slice(0, redirMatch.index).trim();
    }

    const t = tokenize(cmdLine);
    const cmd = (t.shift() || '').toLowerCase();
    const rest = t.join(' ');

    const finish = (out, code = 0, newCwd = cwd) => {
      if (redirect) {
        if (redirect.mode === '>>') vfs.append(redirect.path, (out || '') + '\n');
        else vfs.write(redirect.path, (out || '') + '\n', { createParents: true });
        return { out: '', cwd: newCwd, code };
      }
      return { out: out == null ? '' : String(out), cwd: newCwd, code };
    };

    switch (cmd) {
      case 'help': case '?':
        return finish(HELP);

      case 'pwd':
        return finish(cwd);

      case 'ls': case 'dir': {
        const target = join(cwd, t[0] || '');
        const r = vfs.list(target);
        if (r.error) return finish(r.error, 1);
        if (!r.entries.length) return finish('(empty)');
        return finish(r.entries.map(e => (e.type === 'dir' ? 'd ' : '- ') + e.name.padEnd(28) + (e.type === 'dir' ? '<DIR>' : e.size + ' b')).join('\n'));
      }

      case 'cd': {
        const target = join(cwd, t[0] || '/');
        const r = vfs.list(target);
        if (r.error) return finish(r.error, 1);
        return { out: '', cwd: r.path, code: 0 };
      }

      case 'cat': {
        if (!t[0]) return finish('usage: cat <file>', 1);
        const r = vfs.read(join(cwd, t[0]));
        if (r.error) return finish(r.error, 1);
        return finish(r.content);
      }

      case 'echo': case 'write': {
        const text = cmd === 'echo' ? rest.replace(/^["']|["']$/g, '') : t.join(' ');
        if (!redirect && cmd === 'write') {
          // write <file> <text...>  when no redirection is used
          if (t.length >= 2) {
            const p = join(cwd, t[0]);
            const w = vfs.write(p, t.slice(1).join(' ') + '\n', { createParents: true });
            return finish(w.error || ('written ' + w.bytes + ' bytes -> ' + w.path), w.error ? 1 : 0);
          }
        }
        return finish(text);
      }

      case 'mkdir': {
        if (!t[0]) return finish('usage: mkdir <dir>', 1);
        const r = vfs.mkdir(join(cwd, t[0]), true);
        return finish(r.error || '', r.error ? 1 : 0);
      }

      case 'touch': {
        if (!t[0]) return finish('usage: touch <file>', 1);
        const p = join(cwd, t[0]);
        if (vfs.read(p).error) {
          const r = vfs.write(p, '', { createParents: true });
          return finish(r.error || '', r.error ? 1 : 0);
        }
        return finish('');
      }

      case 'rm': case 'del': {
        const recursive = t[0] === '-r' || t[0] === '-rf';
        const target = t[recursive ? 1 : 0];
        if (!target) return finish('usage: rm [-r] <path>', 1);
        const r = vfs.rm(join(cwd, target), recursive);
        return finish(r.error || 'removed ' + r.path, r.error ? 1 : 0);
      }

      case 'cp': {
        if (t.length < 2) return finish('usage: cp <src> <dst>', 1);
        const r = vfs.copy(join(cwd, t[0]), join(cwd, t[1]));
        return finish(r.error || '', r.error ? 1 : 0);
      }

      case 'mv': {
        if (t.length < 2) return finish('usage: mv <src> <dst>', 1);
        const r = vfs.move(join(cwd, t[0]), join(cwd, t[1]));
        return finish(r.error || '', r.error ? 1 : 0);
      }

      case 'tree': {
        const r = vfs.tree(join(cwd, t[0] || ''), Number(t[1]) || 3);
        if (r.error) return finish(r.error, 1);
        return finish(r.entries.map(e => (e.type === 'dir' ? '[D] ' : '    ') + e.path).join('\n') || '(empty)');
      }

      case 'find': case 'grep': {
        if (!t[0]) return finish('usage: find <text> [path]', 1);
        const r = vfs.search(t[0], join(cwd, t[1] || ''));
        if (r.error) return finish(r.error, 1);
        if (!r.count) return finish('no matches');
        return finish(r.hits.map(h => h.path + ':' + h.line + ': ' + h.snippet).join('\n'));
      }

      case 'date': return finish(new Date().toString());
      case 'whoami': return finish('agent');
      case 'uname': return finish('WebOS ' + version + ' (browser kernel, x86-js)');
      case 'clear': return { out: '__CLEAR__', cwd, code: 0 };

      case 'apps': return finish(APPS.join('\n'));

      case 'sysinfo': {
        const s = vfs.stats();
        const st = bus.state();
        return finish(JSON.stringify({
          version, files: s.files, dirs: s.dirs, bytes: s.bytes,
          windows: (st.windows || []).map(w => w.app + ':' + w.title),
          clients: bus.clientCount(), uptimeSec: Math.round(process.uptime())
        }, null, 2));
      }

      case 'history':
        return finish(hist.map((h, i) => String(i + 1).padStart(4) + '  ' + h).join('\n'));

      case 'windows': {
        const st = bus.state();
        if (!st.windows || !st.windows.length) return finish('no windows open');
        return finish(st.windows.map(w => `${w.focused ? '*' : ' '} [${w.id}] ${w.app} - ${w.title}${w.minimized ? ' (minimized)' : ''}`).join('\n'));
      }

      case 'notify': {
        const r = await bus.dispatch({ op: 'notify', args: { text: rest || 'Hello from shell' } }, 6000);
        return finish(r && r.ok ? 'notified' : 'no client connected', r && r.ok ? 0 : 1);
      }

      case 'open': {
        const app = (t[0] || '').toLowerCase();
        if (!app) return finish('usage: open <app> [arg]\napps: ' + APPS.join(', '), 1);
        if (!APPS.includes(app)) return finish('unknown app: ' + app, 1);
        const args = app === 'browser' && t[1] ? { url: t[1] } : app === 'editor' && t[1] ? { path: join(cwd, t[1]) } : { arg: t[1] };
        const r = await bus.dispatch({ op: 'open', app, args }, 8000);
        if (r && r.ok) return finish('opened ' + app + (r.windowId ? ' [' + r.windowId + ']' : ''));
        return finish('client not reachable: ' + ((r && r.error) || 'no client'), 1);
      }

      case 'browse': {
        if (!t[0]) return finish('usage: browse <url>', 1);
        const r = await bus.dispatch({ op: 'navigate', args: { url: t[0], newWindow: false } }, 15000);
        if (r && r.ok) return finish('browsing ' + (r.url || t[0]));
        return finish('client not reachable: ' + ((r && r.error) || 'no client'), 1);
      }

      case 'read': {
        if (!t[0]) return finish('usage: read <url>', 1);
        try {
          const r = await proxy.extractText(t[0]);
          return finish('== ' + (r.title || r.url) + ' ==\n' + r.url + '\n\n' + r.text.slice(0, 4000));
        } catch (e) { return finish('fetch failed: ' + e.message, 1); }
      }

      case 'search': {
        if (!rest) return finish('usage: search <query>', 1);
        try {
          const r = await proxy.search(rest);
          if (!r.results.length) return finish('no results');
          return finish(r.results.map((x, i) => (i + 1) + '. ' + x.title + '\n   ' + x.url).join('\n'));
        } catch (e) { return finish('search failed: ' + e.message, 1); }
      }

      case 'wallpaper': {
        const r = await bus.dispatch({ op: 'wallpaper', args: { css: rest } }, 6000);
        return finish(r && r.ok ? 'wallpaper updated' : 'no client connected', r && r.ok ? 0 : 1);
      }

      case 'agent': {
        // agent state | agent click <ref> | agent type <ref> <text> | agent <op> {json}
        const op = t[0];
        if (!op || op === 'state') return finish(JSON.stringify(bus.state(), null, 2));
        let payload = {};
        if (t[1] && t[1].trim().startsWith('{')) { try { payload = JSON.parse(t.slice(1).join(' ')); } catch (e) { return finish('bad json: ' + e.message, 1); } }
        else if (op === 'click') payload = { ref: Number(t[1]) };
        else if (op === 'type') payload = { ref: Number(t[1]), text: t.slice(2).join(' ') };
        else if (op === 'navigate') payload = { url: t[1] };
        const r = await bus.dispatch({ op, args: payload }, 12000);
        return finish(JSON.stringify(r, null, 2), r && r.ok ? 0 : 1);
      }

      default:
        return finish('command not found: ' + cmd + '  (try `help`)', 127);
    }
  }

  return { run, HELP, APPS, history: (id) => histories.get(id || 'default') || [] };
}

module.exports = { createShell };
