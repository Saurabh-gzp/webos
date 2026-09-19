/* ============ Agent Console — live view of agent <-> OS traffic ============ */
(function () {
  'use strict';
  function mk(t, c, h) { const n = document.createElement(t); if (c) n.className = c; if (h != null) n.innerHTML = h; return n; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  WebOS.registerApp({
    id: 'agent', name: 'Agent Console', icon: '🤖', width: 560, height: 420,
    mount(a) {
      let mode = 'log';
      let since = 0;
      let timer = null;

      const root = a.win.body;
      const head = mk('div', 'toolbar');
      head.innerHTML = `
        <span class="pill" id="agStatus"><span class="dot"></span><span id="agStatusText">…</span></span>
        <input class="inp" id="cmdop" placeholder="op (e.g. open / navigate / read)" spellcheck="false" style="max-width:190px;flex:0 0 190px">
        <input class="inp" id="cmdargs" placeholder='args JSON {"app":"files"}' spellcheck="false">
        <button class="tb-btn primary" data-a="send">Send</button>`;
      const tabs = mk('div', 'panel-tabs');
      [['log', 'Activity'], ['state', 'State'], ['help', 'Help']].forEach(([m, l]) => {
        const b = mk('button', m === mode ? 'active' : '', l);
        b.dataset.m = m;
        b.onclick = () => { mode = m; tabs.querySelectorAll('button').forEach(x => x.classList.toggle('active', x.dataset.m === m)); render(); };
        tabs.appendChild(b);
      });
      const body = mk('div', 'ag-log');
      root.appendChild(head); root.appendChild(tabs); root.appendChild(body);

      const statusPill = head.querySelector('#agStatus');
      const statusText = head.querySelector('#agStatusText');

      head.addEventListener('click', async (e) => {
        if (!e.target.dataset || e.target.dataset.a !== 'send') return;
        const op = head.querySelector('#cmdop').value.trim();
        if (!op) { WebOS.notify('op likho pehle', 'warn', 'agent console'); return; }
        let args = {};
        const raw = head.querySelector('#cmdargs').value.trim();
        if (raw) { try { args = JSON.parse(raw); } catch (er) { WebOS.notify('bad JSON args: ' + er.message, 'err', 'agent console'); return; } }
        render(); // switch to log view
        mode = 'log';
        tabs.querySelectorAll('button').forEach(x => x.classList.toggle('active', x.dataset.m === 'log'));
        const r = await WebOS.api.post('/api/agent/cmd', { op, args, wait: true, timeout: 20000 });
        WebOS.notify((op + ' → ' + (r.ok ? 'ok' : 'fail: ' + (r.error || ''))).slice(0, 200), r.ok ? 'ok' : 'err', 'agent console');
        poll();
      });

      function render() {
        body.innerHTML = '';
        if (mode === 'log') {
          body.id = 'aglog';
          poll();
        } else if (mode === 'state') {
          const s = WebOS.state();
          s.bridge = { clientId: WebOS.clientId, connected: WebOS.bridge && WebOS.bridge.connected(), recentCommands: (WebOS.bridge && WebOS.bridge.history()) || [] };
          body.innerHTML = `<pre class="mono" style="font-size:11px;white-space:pre-wrap;margin:0">${esc(JSON.stringify(s, null, 2))}</pre>`;
        } else {
          body.innerHTML = `<div style="font-size:12px;line-height:1.7">
            <b style="color:var(--accent)">Agent yahan se OS control karta hai</b>
            <div style="height:8px"></div>
            <code>POST /api/agent/cmd</code> — body: <code>{"op":"open","app":"browser","args":{"url":"https://example.com"},"wait":true}</code><br>
            <code>GET  /api/agent/state</code> — poora OS + browser state<br>
            <code>POST /api/exec</code> — <code>{"cmd":"ls /Home"}</code><br>
            <code>GET  /api/proxy/text?url=…</code> — page ka text<br>
            <code>GET  /api/search?q=…</code> — web search<br>
            <div style="height:10px"></div>
            <b>Common ops</b>
            <table>
              <tr><td><code>open</code></td><td>{app:"files"|"browser"|"editor"|"terminal"|"docs"…}</td></tr>
              <tr><td><code>navigate</code></td><td>{url:"https://…"} — browser me site kholo</td></tr>
              <tr><td><code>read</code></td><td>{mode:"text"|"elements"|"auto"} — page padho</td></tr>
              <tr><td><code>click</code></td><td>{ref:12} ya {text:"Sign in"}</td></tr>
              <tr><td><code>type</code></td><td>{ref:3,text:"hello",submit:true}</td></tr>
              <tr><td><code>scroll</code></td><td>{y:800} ya {y:"bottom"}</td></tr>
              <tr><td><code>search</code></td><td>{q:"best laptops 2026"}</td></tr>
              <tr><td><code>notify</code></td><td>{text:"kaam ho gaya",kind:"ok"}</td></tr>
              <tr><td><code>theme</code></td><td>{mode:"light",accent:"#35d07f"}</td></tr>
              <tr><td><code>wallpaper</code></td><td>{css:"linear-gradient(…) or url(…)"}</td></tr>
              <tr><td><code>window</code> ops</td><td>close / focus / minimize / maximize / move {left,top,width,height}</td></tr>
              <tr><td><code>eval</code></td><td>{code:"document.title"} — browser page ke andar JS</td></tr>
              <tr><td><code>tabs</code></td><td>newtab / closetab / switchtab</td></tr>
            </table>
            <div style="height:10px"></div>
            <b>Tip:</b> upar input me op + args daal ke <i>Send</i> dabao — wahi rasta use hota hai jo agent use karta hai.
          </div>`;
        }
      }

      async function poll() {
        try {
          const st = await WebOS.api.get('/api/agent/state');
          statusPill.classList.toggle('on', (st.clients || 0) > 0);
          statusText.textContent = (st.clients || 0) + ' client' + ((st.clients || 0) === 1 ? '' : 's');
          if (mode !== 'log') return;
          const r = await WebOS.api.get('/api/agent/log', { since });
          const box = body;
          (r.log || []).forEach(e => {
            const row = mk('div', 'ag-row');
            row.innerHTML = `<span class="ts">${new Date(e.ts).toLocaleTimeString()}</span>
              <span class="kind ${esc(e.kind)}">${esc(e.kind)}</span>
              <span class="txt">${esc(e.text)}</span>`;
            box.appendChild(row);
          });
          if (r.log && r.log.length) {
            since = r.last;
            while (box.children.length > 300) box.removeChild(box.firstChild);
            box.scrollTop = box.scrollHeight;
          }
          if (!box.children.length) {
            box.innerHTML = '<div class="empty"><span class="big">🤖</span>Abhi koi agent activity nahi.<br>Terminal me <code>curl</code> chalao ya bahar se <code>/api/agent/cmd</code> hit karo.</div>';
          }
        } catch (e) { /* ignore */ }
      }

      render();
      poll();
      timer = setInterval(poll, 1800);

      return {
        handleCommand(cmd) {
          const op = String(cmd.op || '').toLowerCase();
          if (op === 'agentlog' || op === 'showlog') { mode = 'log'; render(); return { ok: true }; }
          return null;
        },
        destroy() { clearInterval(timer); },
        state() { return { mode, since }; }
      };
    }
  });
})();
