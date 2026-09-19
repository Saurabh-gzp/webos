/* ============================================================
   WebOS Chromium — asli headless Chromium ka live view + agent control
   ------------------------------------------------------------
   Server pe real Chromium chalta hai (Puppeteer/CDP). Ye window:
     - CDP screencast ko live dikhati hai (SSE frames)
     - aapke click / scroll / keyboard seedha usi Chromium me bhejti hai
     - agent ke liye panel deti hai: navigate / click / type / read /
       screenshot / Manus-jaisa multi-step task runner
   External agents isi kaam ko HTTP se bhi kar sakte hain:
     POST /api/browser/task {actions:[...]}
   ============================================================ */
(function () {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function mk(tag, cls, html) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }
  function el(sel, root) { return (root || document).querySelector(sel); }
  function localMode() {
    try { return !!(window.WebOS && WebOS.isLocal); } catch (e) { return false; }
  }

  /* ---------- API base: server build me '' , standalone me remote URL ---------- */
  function apiBase() {
    if (!localMode()) return '';
    try { return (localStorage.getItem('webos.remote') || '').replace(/\/+$/, ''); } catch (e) { return ''; }
  }
  function apiUrl(path) { return apiBase() + path; }

  async function jfetch(path, opts) {
    const res = await fetch(apiUrl(path), opts);
    const txt = await res.text();
    let data;
    try { data = JSON.parse(txt); } catch (e) { data = { ok: false, error: 'bad response: ' + txt.slice(0, 200) }; }
    return { status: res.status, data };
  }

  WebOS.registerApp({
    id: 'chromium',
    name: 'Chromium',
    icon: '🌐',
    desktop: true,
    width: 1080,
    height: 700,
    mount(a) {
      /* ---------------- state ---------------- */
      const S = {
        sessionId: null,
        viewport: { width: 1280, height: 800 },
        title: '', urlLast: '',
        stream: null,
        frameAt: 0,
        frames: 0,
        polling: null,
        log: [],
        elements: [],
        text: '',
        screenshotPath: null,
        busy: false
      };

      /* ---------------- DOM ---------------- */
      const root = a.win.body;
      root.classList.add('cr-root');
      root.innerHTML = `
<div class="cr-top">
  <div class="cr-nav">
    <button class="cr-btn" data-cr="back" title="Back">‹</button>
    <button class="cr-btn" data-cr="forward" title="Forward">›</button>
    <button class="cr-btn" data-cr="reload" title="Reload">⟳</button>
  </div>
  <input class="cr-url" placeholder="https://… (ya search text likho)" spellcheck="false">
  <button class="cr-btn cr-go" data-cr="go">Go</button>
  <div class="cr-sess">
    <select class="cr-sel" data-cr="session" title="Chromium session"></select>
    <button class="cr-btn" data-cr="new" title="Nayi Chromium session (naya browser window)">＋</button>
    <button class="cr-btn cr-x" data-cr="close" title="Ye session band karo">✕</button>
  </div>
  <select class="cr-vp" data-cr="viewport" title="Viewport size">
    <option value="1280x800">1280×800</option>
    <option value="1024x768">1024×768</option>
    <option value="1440x900">1440×900</option>
    <option value="390x844">390×844 (mobile)</option>
  </select>
  <span class="cr-dot" data-cr="dot" title="Chromium status"></span>
</div>

<div class="cr-body">
  <div class="cr-stage">
    <div class="cr-screen-wrap">
      <img class="cr-screen" alt="Chromium live view">
      <div class="cr-overlay" data-cr="overlay">Chromium start ho raha hai…</div>
    </div>
    <div class="cr-statusbar">
      <span data-cr="st-url">—</span>
      <span class="cr-fps" data-cr="st-fps">0 fps</span>
    </div>
    <div class="cr-keyrow">
      <input class="cr-key" placeholder="keyboard: yahan likho aur Enter dabao (live Chromium ko jaata hai)" spellcheck="false">
      <button class="cr-btn" data-key="Tab">Tab</button>
      <button class="cr-btn" data-key="Enter">Enter</button>
      <button class="cr-btn" data-key="Escape">Esc</button>
      <button class="cr-btn" data-key="ArrowDown">↓</button>
      <button class="cr-btn" data-key="PageDown">PgDn</button>
    </div>
  </div>

  <div class="cr-side">
    <div class="cr-tabs">
      <button class="cr-tab on" data-tab="agent">Agent</button>
      <button class="cr-tab" data-tab="task">Task</button>
      <button class="cr-tab" data-tab="read">Read</button>
      <button class="cr-tab" data-tab="els">Refs</button>
      <button class="cr-tab" data-tab="log">Log</button>
    </div>

    <div class="cr-panes">
      <div class="cr-pane on" data-pane="agent">
        <div class="cr-grid">
          <label>action</label>
          <select data-cr="act">
            <option value="navigate">navigate</option>
            <option value="click">click</option>
            <option value="type">type</option>
            <option value="press">press</option>
            <option value="scroll">scroll</option>
            <option value="eval">eval (JS)</option>
            <option value="extract">extract (text)</option>
            <option value="screenshot">screenshot</option>
            <option value="state">state (elements)</option>
            <option value="back">back</option>
            <option value="forward">forward</option>
            <option value="reload">reload</option>
          </select>
          <label>url</label><input data-cr="url" placeholder="https://example.com">
          <label>text / value</label><input data-cr="text" placeholder="type karne ke liye text, ya click karne ke liye label">
          <label>ref</label><input data-cr="ref" placeholder="Refs tab se ref number (jaise 42)">
          <label>selector</label><input data-cr="selector" placeholder="CSS selector (optional)">
          <label>key</label><input data-cr="key" placeholder="Enter / Tab / Escape …">
          <label>x,y</label><input data-cr="xy" placeholder="650,400 (optional)">
        </div>
        <div class="cr-row">
          <button class="cr-run" data-cr="run">Run ▶</button>
          <button class="cr-btn" data-cr="read">Page padho</button>
          <button class="cr-btn" data-cr="shot">Screenshot → VFS</button>
        </div>
        <pre class="cr-out" data-cr="out">ready.</pre>
      </div>

      <div class="cr-pane" data-pane="task">
        <div class="cr-hint">Manus-jaisa multi-step task — JSON actions do, poora flow ek shot me chalega.</div>
        <textarea class="cr-task" spellcheck="false">[
  { "action": "navigate", "url": "https://example.com" },
  { "action": "extract" },
  { "action": "screenshot" }
]</textarea>
        <div class="cr-row">
          <button class="cr-run" data-cr="runtask">Task chalao ▶</button>
          <button class="cr-btn" data-cr="tmpl">Preset: search karo</button>
        </div>
        <pre class="cr-out" data-cr="taskout">external agents: POST /api/browser/task {actions:[…]}</pre>
      </div>

      <div class="cr-pane" data-pane="read">
        <div class="cr-row">
          <button class="cr-btn" data-cr="read2">Text nikalo</button>
          <button class="cr-btn" data-cr="savetext">VFS me save</button>
        </div>
        <pre class="cr-out cr-text" data-cr="text">—</pre>
      </div>

      <div class="cr-pane" data-pane="els">
        <div class="cr-hint">Refs stable hote hain — click/type me ref use karo. Text wale bhi chalte hain.</div>
        <div class="cr-els" data-cr="els"></div>
      </div>

      <div class="cr-pane" data-pane="log">
        <pre class="cr-out" data-cr="log">—</pre>
      </div>
    </div>
  </div>
</div>`;

      const omni = el('.cr-url', root);
      const screen = el('.cr-screen', root);
      const overlay = el('[data-cr="overlay"]', root);
      const out = el('[data-cr="out"]', root);
      const taskOut = el('[data-cr="taskout"]', root);
      const logOut = el('[data-cr="log"]', root);
      const elsBox = el('[data-cr="els"]', root);
      const textBox = el('[data-cr="text"]', root);
      const dot = el('[data-cr="dot"]', root);
      const sessSel = el('[data-cr="session"]', root);

      function log(msg, kind) {
        const t = new Date().toLocaleTimeString();
        S.log.unshift(`[${t}] ${kind ? kind + ' · ' : ''}${msg}`);
        if (S.log.length > 300) S.log.pop();
        logOut.textContent = S.log.join('\n');
      }
      function show(obj) {
        out.textContent = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
      }
      function setDot(state, title) {
        dot.className = 'cr-dot ' + state;
        dot.title = title || '';
      }
      function setOverlay(txt) {
        overlay.textContent = txt || '';
        overlay.style.display = txt ? 'flex' : 'none';
      }
      /* status bar: hamesha "title · url" — title purane page ka na chipka rahe */
      function setStatus(title, url) {
        if (title !== undefined && title !== null) S.title = title;
        if (url) { S.urlLast = url; omni.value = url; }
        el('[data-cr="st-url"]', root).textContent =
          (S.title ? S.title + '  ·  ' : '') + (S.urlLast || '—');
      }

      /* ---------------- local (standalone) mode notice ---------------- */
      if (localMode() && !apiBase()) {
        root.innerHTML = `
<div class="cr-nolocal">
  <h3>🌐 Real Chromium — server mode chahiye</h3>
  <p>Ye file browser me akeli chal rahi hai (single-file build), isliye koi Chromium host nahi hai.
     Asli browser chahiye to WebOS ko server ke saath chalao (<code>node server.js</code>) — ya apne
     deployed server ka URL yahan daal do, phir wahi remote Chromium live dikhega.</p>
  <div class="cr-row">
    <input class="cr-remote" placeholder="https://webos-inte.onrender.com" spellcheck="false">
    <button class="cr-run">Connect</button>
  </div>
  <p class="cr-hint">Local URL: <code>http://localhost:3000</code> — server band ho to error aayega.</p>
</div>`;
        const inp = el('.cr-remote', root);
        try { inp.value = localStorage.getItem('webos.remote') || ''; } catch (e) {}
        el('.cr-run', root).onclick = () => {
          try { localStorage.setItem('webos.remote', inp.value.trim()); } catch (e) {}
          WebOS.notify('Chromium', 'Remote server set: ' + (inp.value.trim() || '(khali)'));
          a.close && a.close();
        };
        return;
      }

      /* ================= session + live stream ================= */
      async function refreshSessions(selectId) {
        const r = await jfetch('/api/browser/status');
        const st = r.data || {};
        const list = st.sessions || [];
        sessSel.innerHTML = list.length
          ? list.map(s => `<option value="${esc(s.id)}">${esc(s.id)}${s.title ? ' — ' + esc(String(s.title).slice(0, 40)) : ''}</option>`).join('')
          : '<option value="">(koi session nahi)</option>';
        if (selectId) sessSel.value = selectId;
        S.sessionId = sessSel.value || null;
        setDot(st.running ? 'on' : 'idle', st.version || (st.lastError || ''));
        return st;
      }

      async function newSession(url, vp) {
        setOverlay('Chromium launch ho raha hai…');
        const [w, h] = (vp || el('[data-cr="viewport"]', root).value || '1280x800').split('x').map(Number);
        const r = await jfetch('/api/browser', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ url: url || 'about:blank', width: w, height: h })
        });
        if (!r.data || r.data.ok === false) {
          setOverlay('Chromium nahi chala: ' + ((r.data && r.data.error) || r.status));
          setDot('err', (r.data && r.data.error) || 'error');
          log('session fail: ' + JSON.stringify(r.data), 'error');
          return null;
        }
        S.sessionId = r.data.sessionId;
        S.viewport = r.data.viewport || { width: w || 1280, height: h || 800 };
        await refreshSessions(S.sessionId);
        attachStream(S.sessionId);
        setStatus(r.data.title, r.data.url);
        setOverlay('');
        log('session ' + S.sessionId + ' → ' + (r.data.url || ''), 'open');
        afterAction(r.data);
        return S.sessionId;
      }

      function attachStream(id) {
        if (S.stream) { try { S.stream.close(); } catch (e) {} S.stream = null; }
        if (S.polling) { clearInterval(S.polling); S.polling = null; }
        if (!id) return;
        try {
          const es = new EventSource(apiUrl('/api/browser/' + id + '/stream'));
          S.stream = es;
          es.onmessage = (ev) => {
            let d; try { d = JSON.parse(ev.data); } catch (e) { return; }
            if (d.type === 'frame' && d.jpeg) {
              screen.src = 'data:image/jpeg;base64,' + d.jpeg;
              S.frames++; S.frameAt = Date.now();
            } else if (d.type === 'nav') {
              setStatus(d.title, d.url);
            } else if (d.type === 'hello') {
              S.viewport = d.viewport || S.viewport;
              setOverlay('');
            } else if (d.type === 'closed' || d.type === 'browser-closed') {
              setOverlay('Session band ho gaya');
              log('stream: ' + d.type, 'warn');
            }
          };
          es.onerror = () => { /* EventSource khud reconnect karta hai */ };
        } catch (e) {
          log('stream error: ' + e.message, 'error');
        }
        // fallback: SSE se frames na aayein to /frame se poll karo (~2 fps)
        S.polling = setInterval(async () => {
          if (Date.now() - S.frameAt < 2500) return;
          if (!S.sessionId || S.busy) return;
          try {
            const r = await jfetch('/api/browser/' + S.sessionId + '/frame');
            if (r.data && r.data.jpeg) { screen.src = 'data:image/jpeg;base64,' + r.data.jpeg; S.frameAt = Date.now(); S.frames++; }
          } catch (e) {}
        }, 2000);
      }

      setInterval(() => {
        const fps = Math.round(S.frames / 5);
        S.frames = 0;
        el('[data-cr="st-fps"]', root).textContent = fps + ' fps';
      }, 5000);

      /* ---------------- response handling ---------------- */
      function afterAction(data) {
        if (!data) return;
        if (data.url !== undefined) setStatus(data.title, data.url);
        if (data.elements) { S.elements = data.elements; renderElements(data.elements); }
        if (data.text) { S.text = data.text; }
        if (data.service_worker === undefined && data.ok === false) log('action fail: ' + (data.error || ''), 'error');
      }

      function renderElements(list) {
        if (!list || !list.length) { elsBox.innerHTML = '<div class="cr-hint">koi element nahi mila</div>'; return; }
        elsBox.innerHTML = list.slice(0, 200).map(e => `
<div class="cr-el" data-ref="${esc(e.ref)}" data-kind="${esc(e.kind)}">
  <span class="cr-ref">${esc(e.ref)}</span>
  <span class="cr-kind k-${esc(e.kind)}">${esc(e.kind)}</span>
  <span class="cr-etext" title="${esc(e.text)}">${esc(String(e.text || '').slice(0, 70))}</span>
</div>`).join('');
        elsBox.querySelectorAll('.cr-el').forEach(n => {
          n.onclick = () => {
            el('[data-cr="ref"]', root).value = n.dataset.ref;
            if (n.dataset.kind === 'input') el('[data-cr="act"]', root).value = 'type';
            else el('[data-cr="act"]', root).value = 'click';
            tabTo('agent');
          };
        });
      }

      /* ---------------- actions ---------------- */
      async function runAct() {
        const act = el('[data-cr="act"]', root).value;
        const body = { action: act };
        const url = el('[data-cr="url"]', root).value.trim() || omni.value.trim();
        const text = el('[data-cr="text"]', root).value;
        const ref = el('[data-cr="ref"]', root).value.trim();
        const selector = el('[data-cr="selector"]', root).value.trim();
        const key = el('[data-cr="key"]', root).value.trim();
        const xy = el('[data-cr="xy"]', root).value.trim();
        if (act === 'navigate') body.url = url;
        if (text) {
          if (act === 'click') body.text = text;
          else if (act === 'type') body.text = text;
          else body.value = text;
        }
        if (ref) body.ref = ref;
        if (selector) body.selector = selector;
        if (key) body.key = key;
        if (xy && /^\d+\s*,\s*\d+$/.test(xy)) { const [x, y] = xy.split(',').map(s => Number(s.trim())); body.x = x; body.y = y; }
        if (act === 'eval') body.code = text || el('[data-cr="text"]', root).value;
        if (act === 'type' && !body.ref && !body.selector && !body.x) body.focus = false;

        if (!S.sessionId) {
          if (act === 'navigate') return newSession(body.url);
          const st = await refreshSessions();
          if (!S.sessionId) { show({ ok: false, error: 'pehle session banao (＋ button)' }); return; }
        }
        S.busy = true;
        setOverlay('agent chala raha hai…');
        const t0 = Date.now();
        const r = await jfetch('/api/browser/' + S.sessionId + '/act', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
        });
        S.busy = false;
        setOverlay('');
        const d = r.data || {};
        log(act + ' (' + (Date.now() - t0) + 'ms) → ' + (d.ok === false ? 'FAIL ' + d.error : (d.url || 'ok')), d.ok === false ? 'error' : 'act');
        if (act === 'extract' && d.text) { textBox.textContent = d.text; tabTo('read'); }
        show(d);
        afterAction(d);
        return d;
      }

      async function readPage() {
        if (!S.sessionId) return show({ ok: false, error: 'session nahi hai' });
        setOverlay('page padh raha hai…');
        const r = await jfetch('/api/browser/' + S.sessionId + '/extract');
        setOverlay('');
        const d = r.data || {};
        S.text = d.text || '';
        textBox.textContent = d.text || '(khali)';
        log('extract → ' + (d.text || '').length + ' chars', 'read');
        tabTo('read');
        show({ ok: d.ok, title: d.title, url: d.url, chars: (d.text || '').length, headings: (d.headings || []).length, links: (d.links || []).length });
        return d;
      }

      async function screenshotToVfs() {
        if (!S.sessionId) return show({ ok: false, error: 'session nahi hai' });
        // screenshot binary aata hai -> base64 bana kar VFS me daalo
        try {
          const res = await fetch(apiUrl('/api/browser/' + S.sessionId + '/screenshot?type=png'));
          const blob = await res.blob();
          const b64 = await new Promise((resolve) => {
            const fr = new FileReader();
            fr.onload = () => resolve(String(fr.result).split(',')[1]);
            fr.readAsDataURL(blob);
          });
          const path = '/Home/Screenshots/chromium-' + Date.now() + '.png';
          const w = await jfetch('/api/fs/write', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path, content: b64, binary: true, mime: 'image/png' })
          });
          S.screenshotPath = path;
          log('screenshot → ' + path, 'shot');
          show({ ok: true, path, bytes: blob.size, preview: apiUrl('/api/fs/raw?path=' + encodeURIComponent(path)) });
          WebOS.notify('Chromium', 'Screenshot saved: ' + path);
          return w.data;
        } catch (e) {
          show({ ok: false, error: e.message });
        }
      }

      async function runTask() {
        const ta = el('.cr-task', root);
        let actions;
        try { actions = JSON.parse(ta.value); } catch (e) { return (taskOut.textContent = 'JSON galat hai: ' + e.message); }
        if (!Array.isArray(actions)) actions = actions.actions || [];
        taskOut.textContent = 'chal raha hai… (' + actions.length + ' steps)';
        const r = await jfetch('/api/browser/task', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ actions, sessionId: S.sessionId || undefined, include: 'text' })
        });
        const d = r.data || {};
        taskOut.textContent = (d.results || []).map(x =>
          `#${x.step} ${x.action.padEnd(9)} ${x.ok ? '✓' : '✗'} ${x.ms}ms  ${x.url || ''}${x.error ? '  ! ' + x.error : ''}`
        ).join('\n') + `\n\nfinal: ${(d.final && d.final.url) || '-'}\n${d.ok ? '✅ task ok' : '❌ task failed'}`;
        if (d.sessionId) { S.sessionId = d.sessionId; await refreshSessions(d.sessionId); attachStream(d.sessionId); }
        const lastText = [...(d.results || [])].reverse().find(x => x.text);
        if (lastText) { textBox.textContent = lastText.text; }
        log('task ' + d.steps + '/' + d.total + (d.ok ? ' ok' : ' failed'), d.ok ? 'task' : 'error');
        if (d.final) setStatus(d.final.title, d.final.url);
        return d;
      }

      /* ---------------- toolbar wiring ---------------- */
      el('[data-cr="go"]', root).onclick = async () => {
        const u = omni.value.trim();
        if (!u) return;
        el('[data-cr="url"]', root).value = u;
        if (!S.sessionId) return newSession(u);
        el('[data-cr="act"]', root).value = 'navigate';
        return runAct();
      };
      omni.addEventListener('keydown', e => { if (e.key === 'Enter') el('[data-cr="go"]', root).click(); });
      el('[data-cr="back"]', root).onclick = () => { el('[data-cr="act"]', root).value = 'back'; runAct(); };
      el('[data-cr="forward"]', root).onclick = () => { el('[data-cr="act"]', root).value = 'forward'; runAct(); };
      el('[data-cr="reload"]', root).onclick = () => { el('[data-cr="act"]', root).value = 'reload'; runAct(); };
      el('[data-cr="new"]', root).onclick = () => newSession(omni.value.trim() || 'https://example.com');
      el('[data-cr="close"]', root).onclick = async () => {
        if (!S.sessionId) return;
        const r = await jfetch('/api/browser/' + S.sessionId + '/close', { method: 'POST', body: '{}' });
        log('session closed: ' + S.sessionId, 'close');
        if (S.stream) { try { S.stream.close(); } catch (e) {} S.stream = null; }
        if (S.polling) clearInterval(S.polling);
        S.sessionId = null;
        await refreshSessions();
        const st = await refreshSessions();
        if ((st.sessions || []).length) attachStream(st.sessions[0].id);
        else setOverlay('koi session nahi — ＋ dabao');
        show(r.data);
      };
      sessSel.onchange = () => { S.sessionId = sessSel.value || null; if (S.sessionId) attachStream(S.sessionId); };
      el('[data-cr="viewport"]', root).onchange = (e) => {
        const [w, h] = e.target.value.split('x').map(Number);
        WebOS.notify('Chromium', 'Naya viewport ' + w + '×' + h + ' — nayi session me lagega');
        S.viewport = { width: w, height: h };
      };

      /* live view me click / scroll -> seedha Chromium me */
      screen.addEventListener('click', async (e) => {
        if (!S.sessionId) return;
        const rect = screen.getBoundingClientRect();
        const x = Math.round((e.clientX - rect.left) * S.viewport.width / rect.width);
        const y = Math.round((e.clientY - rect.top) * S.viewport.height / rect.height);
        // visual feedback
        const ping = mk('div', 'cr-ping');
        ping.style.left = (e.clientX - rect.left) + 'px';
        ping.style.top = (e.clientY - rect.top) + 'px';
        el('.cr-screen-wrap', root).appendChild(ping);
        setTimeout(() => ping.remove(), 500);
        S.busy = true;
        const r = await jfetch('/api/browser/' + S.sessionId + '/click', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ x, y, elements: false })
        });
        S.busy = false;
        if (r.data && r.data.url) setStatus(r.data.title, r.data.url);
        log('click ' + x + ',' + y + ' → ' + ((r.data && r.data.url) || ''), 'human');
      });
      screen.addEventListener('wheel', async (e) => {
        if (!S.sessionId) return;
        e.preventDefault();
        if (S.busy) return;
        S.busy = true;
        await jfetch('/api/browser/' + S.sessionId + '/scroll', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ y: Math.round(e.deltaY * 1.5), elements: false })
        });
        S.busy = false;
      }, { passive: false });

      const keyIn = el('.cr-key', root);
      keyIn.addEventListener('keydown', async (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const text = keyIn.value;
          keyIn.value = '';
          if (!S.sessionId) return;
          await jfetch('/api/browser/' + S.sessionId + '/type', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text, focus: false, clear: false, submit: true })
          });
          log('keyboard: "' + text + '" + Enter', 'human');
        }
      });
      root.querySelectorAll('[data-key]').forEach(b => {
        b.onclick = async () => {
          if (!S.sessionId) return;
          await jfetch('/api/browser/' + S.sessionId + '/press', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: b.dataset.key })
          });
          log('key press: ' + b.dataset.key, 'human');
        };
      });

      /* tabs + buttons */
      function tabTo(name) {
        root.querySelectorAll('.cr-tab').forEach(t => t.classList.toggle('on', t.dataset.tab === name));
        root.querySelectorAll('.cr-pane').forEach(p => p.classList.toggle('on', p.dataset.pane === name));
      }
      root.querySelectorAll('.cr-tab').forEach(t => t.onclick = () => tabTo(t.dataset.tab));
      el('[data-cr="run"]', root).onclick = runAct;
      el('[data-cr="read"]', root).onclick = readPage;
      el('[data-cr="read2"]', root).onclick = readPage;
      el('[data-cr="shot"]', root).onclick = screenshotToVfs;
      el('[data-cr="runtask"]', root).onclick = runTask;
      el('[data-cr="tmpl"]', root).onclick = () => {
        el('.cr-task', root).value = JSON.stringify([
          { action: 'navigate', url: 'https://duckduckgo.com' },
          { action: 'type', text_selector: 'Search', text: 'manus ai browser agent', submit: true },
          { action: 'extract', keep: true },
          { action: 'screenshot' }
        ], null, 2);
      };
      el('[data-cr="savetext"]', root).onclick = async () => {
        if (!S.text) return;
        const path = '/Home/chromium-read-' + Date.now() + '.txt';
        await jfetch('/api/fs/write', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path, content: S.text })
        });
        WebOS.notify('Chromium', 'Text saved: ' + path);
        log('text → ' + path, 'save');
      };

      /* ---------------- boot ---------------- */
      (async () => {
        const st = await refreshSessions();
        setDot(st.running ? 'on' : 'idle', st.version || '');
        if (st.lastError && !st.running) {
          setOverlay('Chromium available nahi: ' + st.lastError.slice(0, 160));
        }
        const first = (st.sessions || [])[0];
        if (first) {
          S.sessionId = first.id;
          sessSel.value = first.id;
          attachStream(first.id);
          setOverlay('');
          setStatus(first.title, first.url);
        } else {
          setOverlay('Chromium start ho raha hai…');
          await newSession('https://example.com');
        }
        log('Chromium app ready · ' + (st.running ? 'engine running' : 'engine idle (pehli session pe launch hoga)'), 'boot');
      })().catch(e => log('boot error: ' + e.message, 'error'));

      /* window band hone par stream/polling saaf karo (warna background me frames aate rahenge) */
      let cleaned = false;
      function cleanup() {
        if (cleaned) return;
        cleaned = true;
        if (S.stream) { try { S.stream.close(); } catch (e) {} S.stream = null; }
        if (S.polling) { clearInterval(S.polling); S.polling = null; }
      }
      try { a.on('window:close', w => { if (w && w.id === a.win.id) cleanup(); }); } catch (e) {}
      try {
        const mo = new MutationObserver(() => { if (!document.contains(a.win.el)) { cleanup(); mo.disconnect(); } });
        mo.observe(document.getElementById('windows') || document.body, { childList: true });
      } catch (e) {}

      /* ================= OS agent ke liye ops =================
         WebOS.handleCommand({op:'chrome.act', args:{...}}) */
      async function handleCommand(cmd) {
        const args = cmd.args || {};
        const op = String(cmd.op || '').toLowerCase();
        const ensure = async () => {
          if (S.sessionId) return S.sessionId;
          if (args.url) return await newSession(args.url);
          const st = await refreshSessions();
          const first = (st.sessions || [])[0];
          if (first) { S.sessionId = first.id; attachStream(first.id); return first.id; }
          return await newSession('about:blank');
        };
        switch (op) {
          case 'chrome.status': case 'chromium.status': {
            const st = await refreshSessions();
            return { ok: true, running: st.running, version: st.version, sessions: st.sessions, appSession: S.sessionId };
          }
          case 'chrome.open': case 'chromium.open':
            return { ok: true, sessionId: await ensure(), url: args.url, viewport: S.viewport };
          case 'chrome.goto': case 'chromium.goto': case 'chrome.navigate': case 'chromium.navigate': {
            S.sessionId = await ensure();
            el('[data-cr="act"]', root).value = 'navigate';
            el('[data-cr="url"]', root).value = args.url || '';
            const d = await runAct();
            return { ok: d && d.ok !== false, url: (d && d.url) || args.url, title: d && d.title, elements: d && d.elementCount };
          }
          case 'chrome.read': case 'chromium.read': case 'chrome.extract': {
            S.sessionId = await ensure();
            const d = await readPage();
            return { ok: true, url: d && d.url, title: d && d.title, text: (d && d.text || '').slice(0, Number(args.limit) || 12000) };
          }
          case 'chrome.screenshot': {
            S.sessionId = await ensure();
            const d = await screenshotToVfs();
            return { ok: true, path: S.screenshotPath };
          }
          case 'chrome.click': case 'chrome.type': case 'chrome.act': case 'chromium.act': {
            S.sessionId = await ensure();
            const act = op.endsWith('.click') ? 'click' : op.endsWith('.type') ? 'type' : (args.action || 'click');
            el('[data-cr="act"]', root).value = act;
            el('[data-cr="text"]', root).value = args.text || args.value || '';
            el('[data-cr="ref"]', root).value = args.ref || '';
            el('[data-cr="selector"]', root).value = args.selector || '';
            const d = await runAct();
            return { ok: (d && d.ok) !== false, url: d && d.url, title: d && d.title, error: d && d.error };
          }
          case 'chrome.task': case 'chromium.task': {
            S.sessionId = await ensure();
            el('.cr-task', root).value = JSON.stringify(args.actions || []);
            const d = await runTask();
            return d;
          }
          case 'chrome.elements': {
            S.sessionId = await ensure();
            const r = await jfetch('/api/browser/' + S.sessionId + '/state');
            const d = r.data || {};
            S.elements = d.elements || [];
            renderElements(S.elements);
            tabTo('els');
            return { ok: true, url: d.url, elementCount: d.elementCount, elements: S.elements.slice(0, Number(args.limit) || 60) };
          }
          default:
            return { ok: false, error: 'unknown chromium op: ' + op };
        }
      }

      a.publishState({
        sessionId: S.sessionId, viewport: S.viewport,
        screenshotPath: S.screenshotPath,
        ops: ['chrome.status', 'chrome.open', 'chrome.goto', 'chrome.read', 'chrome.click', 'chrome.type', 'chrome.act', 'chrome.screenshot', 'chrome.elements', 'chrome.task']
      });

      return { handleCommand, chrome: S };
    }
  });
})();
