/* ============ misc apps: Calculator, Settings, Docs, Monitor, Music ============ */
(function () {
  'use strict';
  function mk(t, c, h) { const n = document.createElement(t); if (c) n.className = c; if (h != null) n.innerHTML = h; return n; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  /* ---------------- Calculator ---------------- */
  WebOS.registerApp({
    id: 'calc', name: 'Calculator', icon: '🧮', width: 320, height: 420,
    mount(a) {
      let expr = '';
      const root = a.win.body;
      const out = mk('div', 'calc-out', '0');
      const grid = mk('div', 'calc-grid');
      root.appendChild(out); root.appendChild(grid);
      const keys = ['C', '(', ')', '/', '7', '8', '9', '*', '4', '5', '6', '-', '1', '2', '3', '+', '0', '.', '⌫', '='];
      function evalExpr() {
        try {
          if (!/^[\d+\-*/(). %]+$/.test(expr)) throw new Error('bad');
          const v = Function('"use strict";return (' + (expr || '0') + ')')();
          return String(v);
        } catch (e) { return 'error'; }
      }
      keys.forEach(k => {
        const b = mk('button', '', k);
        b.dataset.key = k;
        b.onclick = () => {
          if (k === 'C') expr = '';
          else if (k === '⌫') expr = expr.slice(0, -1);
          else if (k === '=') expr = evalExpr() === 'error' ? expr : evalExpr();
          else expr += k;
          out.textContent = expr || '0';
          a.publishState({ expr, result: out.textContent });
        };
        grid.appendChild(b);
      });
      return {
        handleCommand(cmd) {
          const op = String(cmd.op || '').toLowerCase();
          const args = cmd.args || {};
          if (op === 'calc' || op === 'compute') {
            const e = String(args.expr || args.text || '');
            if (!e) return { ok: false, error: 'args.expr required' };
            expr = e;
            const v = evalExpr();
            out.textContent = v;
            a.publishState({ expr, result: v });
            return { ok: v !== 'error', expr: e, result: v };
          }
          return null;
        },
        state() { return { expr, result: out.textContent }; }
      };
    }
  });

  /* ---------------- Settings ---------------- */
  WebOS.registerApp({
    id: 'settings', name: 'Settings', icon: '⚙️', width: 620, height: 560,
    mount(a) {
      const root = a.win.body;
      const ACCENTS = [['#6b8cff', 'indigo'], ['#35d07f', 'green'], ['#ff8a4c', 'orange'], ['#ff5c8a', 'pink'], ['#a678ff', 'violet'], ['#39c6d6', 'cyan']];
      const WALLS = [['aurora', null], ['deep space', 'deep space'], ['violet', 'violet'], ['sunset', 'sunset'], ['forest', 'forest'], ['paper', 'paper']];
      root.innerHTML = `
        <div class="section">
          <h4>Appearance</h4>
          <div class="rowline"><span>Themes</span>
            <span>
              <button class="tb-btn" data-theme="dark">Dark</button>
              <button class="tb-btn" data-theme="light">Light</button>
            </span>
          </div>
          <div class="rowline"><span>Accent</span><span class="swatches" id="accents"></span></div>
          <div style="margin-top:10px" class="wall-grid" id="walls"></div>
        </div>
        <div class="section">
          <h4>System</h4>
          <div class="kv" id="sysinfo"></div>
        </div>
        <div class="section">
          <h4>Danger zone</h4>
          <div class="rowline"><span>Virtual filesystem reset (sab files delete)</span>
            <button class="tb-btn" id="reset">Factory reset</button></div>
        </div>
        <div class="section">
          <h4>About</h4>
          <p style="font-size:12.5px;line-height:1.7;margin:0">
            <b>WebOS 1.0</b> — ek browser-based operating system jo agents ke liye optimize kiya gaya hai.
            Window manager, virtual filesystem, shell, web proxy aur agent bus sab included hain.
            Agent <code>/api/agent/cmd</code> se isi GUI ko drive karta hai.
          </p>
        </div>`;

      const acc = root.querySelector('#accents');
      ACCENTS.forEach(([hex, name]) => {
        const b = mk('div', 'sw' + (WebOS.settings.accent === hex ? ' on' : ''));
        b.style.background = hex; b.title = name;
        b.onclick = () => { WebOS.setAccent(hex); acc.querySelectorAll('.sw').forEach(x => x.classList.remove('on')); b.classList.add('on'); };
        acc.appendChild(b);
      });

      const walls = root.querySelector('#walls');
      WALLS.forEach(([name, key]) => {
        const css = key ? WebOS.WALLS[key] : null;
        const b = mk('div', 'wall');
        b.style.background = css || 'radial-gradient(600px 400px at 20% 10%, #1d2b5e, transparent), linear-gradient(160deg,#0a0c12,#131726)';
        b.title = name;
        b.onclick = () => {
          if (key) WebOS.setWallpaper(css);
          else WebOS.setWallpaper(null);
          walls.querySelectorAll('.wall').forEach(x => x.classList.remove('on'));
          b.classList.add('on');
        };
        walls.appendChild(b);
      });

      root.querySelectorAll('[data-theme]').forEach(b => b.onclick = () => WebOS.setTheme(b.dataset.theme));

      fetch('/api/meta').then(r => r.json()).then(m => {
        fetch('/api/fs/stats').then(r => r.json()).then(s => {
          const info = root.querySelector('#sysinfo');
          info.innerHTML = `
            <b>version</b><span>${m.version} (${m.apps.length} apps)</span>
            <b>kernel</b><span>node ${esc((navigator.userAgent.match(/Chrome\/[\d.]+/) || ['browser'])[0])}</span>
            <b>client id</b><span class="mono">${esc(WebOS.clientId || '—')}</span>
            <b>vfs files</b><span>${s.files} files · ${s.dirs} dirs · ${(s.bytes / 1024).toFixed(1)} KB</span>
            <b>agent api</b><span class="mono">POST /api/agent/cmd · GET /api/agent/state</span>
            <b>window size</b><span>${window.innerWidth} × ${window.innerHeight}</span>`;
        });
      });

      root.querySelector('#reset').onclick = async () => {
        const ok = await WebOS.confirm('Poora virtual filesystem reset karna hai? Saari files hat jayengi.');
        if (!ok) return;
        await fetch('/api/fs/write', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: '/.__reset', content: 'x' }) });
        WebOS.notify('Filesystem reset (server restart se defaults wapas aate hain).', 'warn', 'settings');
      };

      return {
        handleCommand(cmd) {
          const op = String(cmd.op || '').toLowerCase();
          if (op === 'open-settings' || op === 'restart') { location.reload(); return { ok: true }; }
          return null;
        },
        state() { return { theme: WebOS.settings.theme, accent: WebOS.settings.accent }; }
      };
    }
  });

  /* ---------------- Docs ---------------- */
  const DOCS = {
    index: {
      title: 'WebOS Manual',
      html: `
        <h1>◈ WebOS 1.0 — Manual</h1>
        <p>Ye ek <b>browser-based operating system</b> hai. Sab kuch browser me chalta hai, lekin
        backend ek chhota Node server hai jo files, shell, web proxy aur agent bus handle karta hai.</p>
        <h2>Kya kya hai isme</h2>
        <ul>
          <li><b>Window manager</b> — drag, resize, minimize, maximize, multi-window, taskbar</li>
          <li><b>Virtual filesystem</b> — /Home/Documents, Downloads, Projects… server pe JSON me persist</li>
          <li><b>Files / Editor</b> — files banao, padho, edit karo, download karo</li>
          <li><b>Terminal</b> — <code>ls, cd, cat, mkdir, write, open, browse, read, search, agent…</code></li>
          <li><b>Browser</b> — real internet, server-side proxy ke through, multi-tab, elements panel</li>
          <li><b>Agent Console</b> — live view ki agent kya kar raha hai</li>
          <li><b>Agent API</b> — koi bhi agent (LLM, script, curl) OS ko drive kar sakta hai</li>
        </ul>
        <h2>Agent ke liye</h2>
        <pre>curl -s localhost:3000/api/agent/state | jq

curl -s localhost:3000/api/agent/cmd -H 'content-type: application/json' -d '{
  "op":"navigate", "app":"browser",
  "args": {"url":"https://news.ycombinator.com"}, "wait": true
}'

curl -s localhost:3000/api/agent/cmd -H 'content-type: application/json' -d '{
  "op":"read", "args": {"mode":"elements"}, "wait": true
}'</pre>
        <p>Har command ka result turant milta hai (<code>wait:true</code>), aur OS ka poora state
        <code>/api/agent/state</code> pe available rehta hai — windows, focused app, browser page, DOM refs, text.</p>`
    },
    shortcuts: {
      title: 'Shortcuts & Tips',
      html: `
        <h1>Shortcuts</h1>
        <table>
          <tr><th>Key</th><th>Action</th></tr>
          <tr><td><span class="kbd">Ctrl</span> + <span class="kbd">Space</span></td><td>Start menu</td></tr>
          <tr><td><span class="kbd">Ctrl</span> + <span class="kbd">K</span></td><td>Browser address bar focus</td></tr>
          <tr><td><span class="kbd">Ctrl</span> + <span class="kbd">T</span></td><td>New browser tab</td></tr>
          <tr><td><span class="kbd">Ctrl</span> + <span class="kbd">W</span></td><td>Active window close</td></tr>
          <tr><td><span class="kbd">Alt</span> + <span class="kbd">←</span></td><td>Browser back</td></tr>
          <tr><td>double-click titlebar</td><td>Maximize / restore window</td></tr>
        </table>
        <h2>Terminal examples</h2>
        <pre>ls /Home
mkdir /Home/Projects/demo
write /Home/Projects/demo/readme.md "hello world"
cat /Home/Projects/demo/readme.md
browse https://example.com
read https://example.com
search webos operating system
open editor /Home/Documents/welcome.txt
agent state
notify "terminal se hello"</pre>`
    }
  };

  WebOS.registerApp({
    id: 'docs', name: 'Docs', icon: '📖', width: 700, height: 540,
    mount(a) {
      const page = (a.args && (a.args.page || a.args.arg)) || 'index';
      const root = a.win.body;
      const bar = mk('div', 'toolbar');
      bar.innerHTML = `<button class="tb-btn" data-p="index">Manual</button><button class="tb-btn" data-p="shortcuts">Shortcuts</button>`;
      const view = mk('div', 'doc');
      view.style.cssText = 'flex:1;overflow:auto;padding:18px';
      root.appendChild(bar); root.appendChild(view);
      function show(p) {
        const d = DOCS[p] || DOCS.index;
        view.innerHTML = d.html;
        a.setTitle('Docs', d.title);
        bar.querySelectorAll('[data-p]').forEach(b => b.classList.toggle('primary', b.dataset.p === p));
        a.publishState({ page: p, title: d.title });
      }
      bar.onclick = (e) => { if (e.target.dataset.p) show(e.target.dataset.p); };
      show(page);
      return {
        handleCommand(cmd) {
          const op = String(cmd.op || '').toLowerCase();
          if (op === 'showpage' || op === 'doc') {
            show(cmd.args && (cmd.args.page || cmd.args.arg) || 'index');
            return { ok: true, page: cmd.args && cmd.args.page };
          }
          return null;
        },
        state() { return { page: (view.querySelector('h1') || {}).textContent }; }
      };
    }
  });

  /* ---------------- Monitor (task manager) ---------------- */
  WebOS.registerApp({
    id: 'monitor', name: 'Monitor', icon: '📊', width: 640, height: 480,
    mount(a) {
      const root = a.win.body;
      const bar = mk('div', 'toolbar');
      bar.innerHTML = `<button class="tb-btn primary" data-a="refresh">⟳ Refresh</button>
        <span style="color:var(--muted);font-size:11.5px" id="up"></span>`;
      const body = mk('div', 'panel-body');
      root.appendChild(bar); root.appendChild(body);

      async function refresh() {
        const [meta, stats, agent] = await Promise.all([
          fetch('/api/meta').then(r => r.json()),
          fetch('/api/fs/stats').then(r => r.json()),
          fetch('/api/agent/state').then(r => r.json())
        ]);
        const s = WebOS.state();
        const mem = performance.memory ? (performance.memory.usedJSHeapSize / 1048576).toFixed(1) + ' MB' : 'n/a';
        body.innerHTML = `
          <div class="kv">
            <b>WebOS</b><span>v${meta.version} · ${meta.apps.length} apps</span>
            <b>agent clients</b><span>${agent.clients || 0} connected ${agent.connected ? '✅' : '⚠️ none'}</span>
            <b>agent queue</b><span>${agent.queueDepth || 0} pending</span>
            <b>files</b><span>${stats.files} files · ${stats.dirs} dirs · ${(stats.bytes / 1024).toFixed(1)} KB</span>
            <b>JS heap</b><span>${mem}</span>
            <b>screen</b><span>${window.innerWidth}×${window.innerHeight} @ ${window.devicePixelRatio}x</span>
            <b>online</b><span>${navigator.onLine ? 'yes' : 'no'}</span>
          </div>
          <h4 style="margin:16px 0 8px;font-size:11px;letter-spacing:.12em;color:var(--muted)">OPEN WINDOWS (${s.windows.length})</h4>
          ${s.windows.map(w => `<div class="rowline" style="border-bottom:1px solid var(--line)">
            <span>${w.focused ? '🟢' : '⚪'} <b>${esc(w.app)}</b> — ${esc(w.title)}</span>
            <span class="mono" style="font-size:10.5px;color:var(--muted)">${w.rect.width}×${w.rect.height} @${w.rect.left},${w.rect.top}${w.minimized ? ' · min' : ''}</span>
          </div>`).join('') || '<div class="empty">koi window open nahi</div>'}
          <h4 style="margin:16px 0 8px;font-size:11px;letter-spacing:.12em;color:var(--muted)">RECENT AGENT ACTIVITY</h4>
          ${(WebOS.bridge && WebOS.bridge.history() || []).slice(-8).map(c =>
            `<div class="rowline" style="border-bottom:1px solid var(--line)"><span class="mono" style="font-size:11px">${esc(c.op)} ${esc(JSON.stringify(c.args || {}).slice(0, 60))}</span>
            <span class="badge" style="background:${c.ok ? 'rgba(53,208,127,.2)' : 'rgba(255,92,108,.2)'}">${c.ok ? 'ok' : 'fail'} ${c.ms || 0}ms</span></div>`).join('') || '<div style="color:var(--muted);font-size:12px">abhi koi command nahi aayi</div>'}
        `;
        bar.querySelector('#up').textContent = 'state age: ' + Math.round((Date.now() - (agent.ts || Date.now())) / 1000) + 's';
      }
      bar.onclick = (e) => { if (e.target.dataset.a === 'refresh') refresh(); };
      refresh();
      const t = setInterval(refresh, 3000);
      return { destroy() { clearInterval(t); }, state() { return { view: 'monitor' }; } };
    }
  });

  /* ---------------- Music (simple tone synth — WebAudio) ---------------- */
  WebOS.registerApp({
    id: 'music', name: 'Music', icon: '🎵', width: 420, height: 300,
    mount(a) {
      const root = a.win.body;
      const p = mk('div', 'panel-body');
      p.innerHTML = `
        <div style="display:flex;flex-direction:column;gap:12px;align-items:center;justify-content:center;height:100%">
          <div style="font-size:32px">🎵</div>
          <div style="font-size:12.5px;color:var(--muted);text-align:center">WebAudio tone synthesizer<br>chhote melodies browser me hi bajti hain</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center">
            ${[['startup', 'C E G C'], ['alert', 'A C# E'], ['chime', 'G B D G'], ['ui', 'E G']].map(([n]) => `<button class="tb-btn" data-t="${n}">${n}</button>`).join('')}
          </div>
          <div style="font-size:11px;color:var(--muted)">Agent op: <code>{"op":"tone","args":{"name":"chime"}}</code></div>
        </div>`;
      root.appendChild(p);
      const NOTES = { C: 261.63, 'C#': 277.18, D: 293.66, 'D#': 311.13, E: 329.63, F: 349.23, 'F#': 369.99, G: 392.0, 'G#': 415.3, A: 440.0, 'A#': 466.16, B: 493.88 };
      const TUNES = { startup: ['C4', 'E4', 'G4', 'C5'], alert: ['A4', 'C#5', 'E5'], chime: ['G4', 'B4', 'D5', 'G5'], ui: ['E4', 'G4'] };
      let ctx = null;
      function play(name) {
        try {
          if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
          const seq = TUNES[name] || TUNES.chime;
          seq.forEach((n, i) => {
            const freq = NOTES[n.replace(/\d/, '')] * (n.endsWith('5') ? 2 : 1);
            const o = ctx.createOscillator();
            const g = ctx.createGain();
            o.type = 'sine'; o.frequency.value = freq;
            g.gain.setValueAtTime(0.0001, ctx.currentTime + i * 0.16);
            g.gain.exponentialRampToValueAtTime(0.22, ctx.currentTime + i * 0.16 + 0.02);
            g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + i * 0.16 + 0.42);
            o.connect(g); g.connect(ctx.destination);
            o.start(ctx.currentTime + i * 0.16); o.stop(ctx.currentTime + i * 0.16 + 0.45);
          });
          return true;
        } catch (e) { return false; }
      }
      p.onclick = (e) => { if (e.target.dataset.t) play(e.target.dataset.t); };
      return {
        handleCommand(cmd) {
          if (String(cmd.op).toLowerCase() === 'tone') {
            const ok = play((cmd.args && cmd.args.name) || 'chime');
            return { ok, played: (cmd.args && cmd.args.name) || 'chime' };
          }
          return null;
        },
        state() { return { tunes: Object.keys(TUNES) }; }
      };
    }
  });
})();
