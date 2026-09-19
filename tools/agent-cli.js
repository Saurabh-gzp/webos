#!/usr/bin/env node
'use strict';
/**
 * agent-cli.js — WebOS ke liye ready-made agent client.
 *
 *   node tools/agent-cli.js state
 *   node tools/agent-cli.js apps
 *   node tools/agent-cli.js shell "ls /Home"
 *   node tools/agent-cli.js open browser
 *   node tools/agent-cli.js nav https://news.ycombinator.com
 *   node tools/agent-cli.js read [text|elements|auto]
 *   node tools/agent-cli.js click 12        # ref
 *   node tools/agent-cli.js click "Sign in" # text se
 *   node tools/agent-cli.js type 3 "hello" --submit
 *   node tools/agent-cli.js search "best laptops 2026"
 *   node tools/agent-cli.js notify "kaam ho gaya"
 *   node tools/agent-cli.js fs /Home
 *   node tools/agent-cli.js write /Home/a.txt "hello"
 *   node tools/agent-cli.js do '{"op":"navigate","args":{"url":"https://example.com"}}'
 *
 * Real Chromium (iframe-proxy ke bajaye asli browser):
 *   node tools/agent-cli.js chrome status
 *   node tools/agent-cli.js chrome open https://news.ycombinator.com
 *   node tools/agent-cli.js chrome goto https://example.com
 *   node tools/agent-cli.js chrome click "Sign in"      # text / ref / selector
 *   node tools/agent-cli.js chrome type "hello" --submit
 *   node tools/agent-cli.js chrome read                 # text + links
 *   node tools/agent-cli.js chrome els                  # element refs
 *   node tools/agent-cli.js chrome shot                 # screenshot -> VFS
 *   node tools/agent-cli.js chrome task '[{"action":"navigate","url":"https://example.com"},{"action":"extract","keep":true}]'

 *
 * ENV: WEBOS_URL (default http://localhost:3000)
 */

const BASE = process.env.WEBOS_URL || 'http://localhost:3000';
const [cmd, ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter(a => a.startsWith('--')));
const positional = rest.filter(a => !a.startsWith('--'));

async function req(path, options) {
  const r = await fetch(BASE + path, options);
  const text = await r.text();
  try { return JSON.parse(text); } catch { return { raw: text, status: r.status }; }
}
const get = (p) => req(p);
const post = (p, body) => req(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function cmdCall(op, args = {}, app) {
  const res = await post('/api/agent/cmd', { op, args, app, wait: true, timeout: Number(process.env.WEBOS_TIMEOUT || 30000) });
  return res;
}

const show = (o) => console.log(typeof o === 'string' ? o : JSON.stringify(o, null, 2));

(async () => {
  switch (cmd) {
    case 'state': return show(await get('/api/agent/state'));
    case 'apps': {
      const s = await get('/api/agent/state');
      return show((s.apps || []).map(a => `${a.icon} ${a.id} — ${a.name}`).join('\n'));
    }
    case 'shell': return show(await post('/api/exec', { cmd: positional.join(' ') }));
    case 'open': return show(await cmdCall('open', positional[1] ? { url: positional[1], path: positional[1] } : {}, positional[0] || 'files'));
    case 'nav': case 'navigate': return show(await cmdCall('navigate', { url: positional[0] }, 'browser'));
    case 'read': return show(await cmdCall('read', { mode: positional[0] || 'auto', limit: Number(positional[1]) || 12000 }, 'browser'));
    case 'elements': return show(await cmdCall('read', { mode: 'elements' }, 'browser'));
    case 'links': return show(await cmdCall('links', {}, 'browser'));
    case 'inputs': return show(await cmdCall('inputs', {}, 'browser'));
    case 'click': {
      const v = positional[0];
      const args = /^\d+$/.test(v || '') ? { ref: Number(v) } : { text: v };
      return show(await cmdCall('click', args, 'browser'));
    }
    case 'type': return show(await cmdCall('type', { ref: Number(positional[0]), text: positional.slice(1).join(' '), submit: flags.has('--submit') }, 'browser'));
    case 'search': return show(await cmdCall('search', { q: positional.join(' ') }, 'browser'));
    case 'notify': return show(await cmdCall('notify', { text: positional.join(' '), kind: flags.has('--err') ? 'err' : 'ok' }));
    case 'theme': return show(await cmdCall('theme', { mode: positional[0], accent: positional[1] }));
    case 'wallpaper': return show(await cmdCall('wallpaper', { css: positional.join(' ') }));
    case 'windows': return show((await get('/api/agent/state')).windows);
    case 'log': return show((await get('/api/agent/log')).log.slice(-40));
    case 'fs': return show(await get('/api/fs/list?path=' + encodeURIComponent(positional[0] || '/')));
    case 'read-file': return show(await get('/api/fs/read?path=' + encodeURIComponent(positional[0])));
    case 'write': return show(await post('/api/fs/write', { path: positional[0], content: positional.slice(1).join(' ') }));
    case 'grep': return show(await get('/api/fs/search?q=' + encodeURIComponent(positional[0]) + '&path=' + encodeURIComponent(positional[1] || '/')));
    case 'extract': return show(await get('/api/proxy/text?url=' + encodeURIComponent(positional[0])));
    case 'websearch': return show(await get('/api/search?q=' + encodeURIComponent(positional.join(' '))));
    case 'chrome': case 'chromium': {
      const sub = (positional[0] || 'status').toLowerCase();
      const arg = positional.slice(1).join(' ');
      if (sub === 'status' || sub === 'sessions') return show(await get('/api/browser/status'));
      if (sub === 'open') return show(await post('/api/browser', { url: arg || 'about:blank' }));
      if (sub === 'goto' || sub === 'nav' || sub === 'navigate') return show(await cmdCall('chromium.goto', { url: arg }));
      if (sub === 'read' || sub === 'extract') {
        const r = await cmdCall('chromium.act', { action: 'extract' });
        if (flags.has('--text')) return show((r.text || '').slice(0, Number(positional[2]) || 20000));
        return show({ ok: r.ok, url: r.url, title: r.title, chars: (r.text || '').length, headings: (r.headings || []).length, links: (r.links || []).slice(0, 25) });
      }
      if (sub === 'els' || sub === 'elements' || sub === 'state') return show(await cmdCall('chromium.act', { action: 'state', limit: Number(positional[1]) || 60 }));
      if (sub === 'click') {
        const args = /^\d+$/.test(arg) ? { action: 'click', ref: Number(arg) } : { action: 'click', text: arg };
        return show(await cmdCall('chromium.act', args));
      }
      if (sub === 'type' || sub === 'fill') {
        return show(await cmdCall('chromium.act', { action: 'type', text: arg, submit: flags.has('--submit'), focus: flags.has('--focus') }));
      }
      if (sub === 'key' || sub === 'press') return show(await cmdCall('chromium.act', { action: 'press', key: arg || 'Enter' }));
      if (sub === 'scroll') return show(await cmdCall('chromium.act', { action: 'scroll', y: Number(arg) || 800 }));
      if (sub === 'eval') return show(await cmdCall('chromium.act', { action: 'eval', code: arg }));
      if (sub === 'shot' || sub === 'screenshot') return show(await cmdCall('chromium.screenshot', { full: flags.has('--full') }));
      if (sub === 'frame') return show(await cmdCall('chromium.frame', {}));
      if (sub === 'close') return show(await cmdCall('chromium.close', { all: flags.has('--all') }));
      if (sub === 'task') {
        const actions = JSON.parse(arg || '[]');
        return show(await cmdCall('chromium.task', { actions, include: 'text' }));
      }
      return show({
        ok: false, error: 'unknown chrome subcommand: ' + sub,
        try: ['status', 'open <url>', 'goto <url>', 'click <ref|text>', 'type <text> [--submit]', 'key <Enter>', 'scroll <y>', 'eval <js>', 'read [--text]', 'els', 'shot', 'frame', 'task [...actions]', 'close [--all]']
      });
    }
    case 'do': {
      const spec = JSON.parse(positional.join(' ') || '{}');
      return show(await cmdCall(spec.op, spec.args || {}, spec.app));
    }
    default:
      console.log(`WebOS agent CLI  (server: ${BASE})

  state | apps | windows | log
  shell "<command>"
  fs [path] | read-file <path> | write <path> "<text>" | grep "<text>" [path]
  open <app> [url|path] | nav <url> | read [text|elements|auto] | links | inputs
  click <ref> | click "<visible text>" | type <ref> "<text>" [--submit]
  search "<query>" | extract <url> | websearch "<query>"
  chrome status | chrome open <url> | chrome goto <url> | chrome read [--text] | chrome els
  chrome click <ref|"text"> | chrome type "<text>" [--submit] | chrome key <Enter> | chrome scroll <y>
  chrome eval "<js>" | chrome shot | chrome frame | chrome task '[{"action":"navigate","url":...}]' | chrome close [--all]
  notify "<text>" | theme [dark|light] [accent] | wallpaper "<css gradient>"
  do '{"op":"...","args":{...}}'`);
  }
})().catch(e => { console.error('agent-cli error:', e.message); process.exit(1); });
