/* ============================================================
   WebOS kernel — app registry, window manager, desktop shell
   ============================================================ */
(function () {
  'use strict';

  const APPS = {};            // id -> manifest
  const ORDER = [];           // desktop order
  const open_ = [];           // open instances (all apps)
  let zTop = 10;
  let winSeq = 0;
  let focusedId = null;
  const appStateFeed = {};    // appId -> last published state (for the agent)
  const settings = { theme: 'dark', accent: '#6b8cff', wallpaper: null };
  const listeners = {};

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  /* ---------------- tiny helpers ---------------- */
  function el(tag, cls, html) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function nowTime() {
    const d = new Date();
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }
  function store(key, val) {
    try {
      if (val === undefined) { const v = localStorage.getItem('webos.' + key); return v ? JSON.parse(v) : null; }
      localStorage.setItem('webos.' + key, JSON.stringify(val));
    } catch (e) { return null; }
  }
  function on(evt, fn) { (listeners[evt] = listeners[evt] || []).push(fn); }
  function emit(evt, data) { (listeners[evt] || []).forEach(f => { try { f(data); } catch (e) { console.warn(e); } }); }

  /* ---------------- REST helpers ---------------- */
  const api = {
    async get(path, params) {
      const qs = params ? '?' + new URLSearchParams(params).toString() : '';
      const r = await fetch(path + qs);
      return r.json().catch(() => ({ error: 'bad json' }));
    },
    async post(path, body) {
      const r = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {})
      });
      return r.json().catch(() => ({ error: 'bad json' }));
    },
    fs: {
      list: (p) => api.get('/api/fs/list', { path: p }),
      read: (p) => api.get('/api/fs/read', { path: p }),
      write: (p, c) => api.post('/api/fs/write', { path: p, content: c }),
      mkdir: (p) => api.post('/api/fs/mkdir', { path: p }),
      rm: (p, recursive = true) => api.post('/api/fs/rm', { path: p, recursive }),
      move: (from, to, copy) => api.post('/api/fs/move', { from, to, copy }),
      tree: (p, depth) => api.get('/api/fs/tree', { path: p, depth }),
      search: (q, p) => api.get('/api/fs/search', { q, path: p })
    },
    shell: (cmd, cwd) => api.post('/api/exec', { cmd, cwd }),
    search: (q) => api.get('/api/search', { q }),
    readUrl: (url) => api.get('/api/proxy/text', { url }),
    proxyUrl: (url) => '/api/proxy?url=' + encodeURIComponent(url)
  };

  /* ---------------- app registration ---------------- */
  function registerApp(manifest) {
    if (!manifest || !manifest.id) return;
    APPS[manifest.id] = Object.assign({
      name: manifest.id, icon: '▪', width: 760, height: 520, desktop: true, singleton: false
    }, manifest);
    if (manifest.desktop !== false && !ORDER.includes(manifest.id)) ORDER.push(manifest.id);
  }

  /* ---------------- window manager ---------------- */
  function desktopRect() {
    const d = $('#desktop').getBoundingClientRect();
    return { w: d.width, h: d.height };
  }

  function createWindow(appId, args) {
    const manifest = APPS[appId];
    if (!manifest) return null;
    if (manifest.singleton) {
      const existing = open_.find(w => w.app === appId);
      if (existing) {
        existing.restore(); existing.focus();
        if (existing.instance && existing.instance.onArgs) existing.instance.onArgs(args || {});
        return existing;
      }
    }
    const dr = desktopRect();
    const width = Math.min(manifest.width, Math.max(360, dr.w - 40));
    const height = Math.min(manifest.height, Math.max(240, dr.h - 40));
    const n = open_.length;
    const left = Math.max(8, Math.round((dr.w - width) / 2) + ((n % 5) - 2) * 26);
    const top = Math.max(8, Math.round((dr.h - height) / 2) + ((n % 5) - 2) * 22);

    const id = 'w' + (++winSeq);
    const root = el('div', 'win');
    root.dataset.id = id;
    root.dataset.app = appId;
    root.style.cssText = `left:${left}px;top:${top}px;width:${width}px;height:${height}px;z-index:${++zTop}`;
    root.innerHTML = `
      <div class="win-titlebar">
        <span class="win-icon">${manifest.icon}</span>
        <span class="win-title">${esc(manifest.name)}</span>
        <div class="win-controls">
          <button class="win-min" title="Minimize">–</button>
          <button class="win-max" title="Maximize">□</button>
          <button class="win-close" title="Close">✕</button>
        </div>
      </div>
      <div class="win-body"></div>
      <div class="win-resize"></div>`;

    const body = $('.win-body', root);
    const titleEl = $('.win-title', root);

    const win = {
      id, app: appId, el: root, body, manifest,
      title: manifest.name,
      minimized: false, maximized: false,
      rect: { left, top, width, height },
      instance: null,
      setTitle(t, sub) {
        win.title = t || manifest.name;
        titleEl.innerHTML = esc(win.title) + (sub ? ` <span class="sub">${esc(sub)}</span>` : '');
        syncTaskbar(); report();
      },
      setSubtitle(sub) {
        titleEl.innerHTML = esc(win.title) + (sub ? ` <span class="sub">${esc(sub)}</span>` : '');
      },
      focus() { focusWin(win); },
      close() { closeWin(win); },
      minimize() {
        win.minimized = true; root.classList.add('min');
        if (focusedId === id) { focusedId = null; focusTopMost(); }
        syncTaskbar(); report();
      },
      restore() {
        win.minimized = false; root.classList.remove('min');
        focusWin(win); report();
      },
      maximize(on) {
        const want = on === undefined ? !win.maximized : !!on;
        win.maximized = want;
        root.classList.toggle('max', want);
        if (want) {
          win._prev = { ...win.rect };
          const dr = desktopRect();
          Object.assign(win.rect, { left: 0, top: 0, width: dr.w, height: dr.h });
        } else if (win._prev) {
          Object.assign(win.rect, win._prev);
        }
        applyRect(win);
        syncTaskbar(); report();
      },
      toggleMax() { win.maximize(); },
      applyRect() { applyRect(win); }
    };

    function applyRect(w) {
      w.el.style.left = w.rect.left + 'px';
      w.el.style.top = w.rect.top + 'px';
      w.el.style.width = w.rect.width + 'px';
      w.el.style.height = w.rect.height + 'px';
    }

    win.applyRect = () => applyRect(win);
    win.toggleMax = () => win.maximize();

    const appApi = {
      win, args: args || {}, kernel: WebOS, api, esc, el, on, emit,
      setTitle: win.setTitle,
      setSubtitle: win.setSubtitle,
      notify: WebOS.notify,
      openApp: (a, ar) => WebOS.open(a, ar),
      publishState: (obj) => { appStateFeed[appId] = Object.assign({}, appStateFeed[appId], obj, { ts: Date.now() }); report(); },
      onCommand: null // assigned by app
    };

    $('#windows').appendChild(root);
    open_.push(win);
    wireWindow(win);
    focusedId = id;
    setFocusClass();
    syncTaskbar();

    const inst = manifest.mount(appApi) || {};
    win.instance = inst;
    if (inst.handleCommand) appApi.onCommand = inst.handleCommand;
    emit('window:open', win);
    report();
    return win;
  }

  function applyRect(w) {
    w.el.style.left = w.rect.left + 'px';
    w.el.style.top = w.rect.top + 'px';
    w.el.style.width = w.rect.width + 'px';
    w.el.style.height = w.rect.height + 'px';
  }

  function focusWin(w) {
    if (!w) return;
    if (w.minimized) { w.minimized = false; w.el.classList.remove('min'); }
    focusedId = w.id;
    w.el.style.zIndex = ++zTop;
    setFocusClass(); syncTaskbar(); report();
  }
  function focusTopMost() {
    const vis = open_.filter(w => !w.minimized);
    if (!vis.length) { focusedId = null; setFocusClass(); return; }
    const top = vis.reduce((a, b) => (Number(a.el.style.zIndex) > Number(b.el.style.zIndex) ? a : b));
    focusedId = top.id; setFocusClass();
  }
  function setFocusClass() {
    open_.forEach(w => w.el.classList.toggle('focus', w.id === focusedId));
  }

  function closeWin(w) {
    if (!w) return;
    try { if (w.instance && w.instance.destroy) w.instance.destroy(); } catch (e) {}
    const i = open_.indexOf(w);
    if (i >= 0) open_.splice(i, 1);
    w.el.remove();
    if (focusedId === w.id) { focusedId = null; focusTopMost(); }
    syncTaskbar(); report(); emit('window:close', w);
  }

  function wireWindow(win) {
    const root = win.el;
    const bar = $('.win-titlebar', root);

    root.addEventListener('pointerdown', () => focusWin(win), true);

    $('.win-min', root).onclick = (e) => { e.stopPropagation(); win.minimize(); };
    $('.win-close', root).onclick = (e) => { e.stopPropagation(); win.close(); };
    $('.win-max', root).onclick = (e) => { e.stopPropagation(); win.maximize(); };
    bar.addEventListener('dblclick', (e) => { if (!e.target.closest('.win-controls')) win.maximize(); });

    // drag
    let drag = null;
    bar.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.win-controls')) return;
      if (win.maximized) return;
      drag = { x: e.clientX, y: e.clientY, left: win.rect.left, top: win.rect.top };
      bar.setPointerCapture(e.pointerId);
      win.el.style.transition = 'none';
    });
    bar.addEventListener('pointermove', (e) => {
      if (!drag) return;
      win.rect.left = Math.max(-win.rect.width + 90, drag.left + e.clientX - drag.x);
      win.rect.top = Math.max(0, drag.top + e.clientY - drag.y);
      applyRect(win);
    });
    bar.addEventListener('pointerup', (e) => {
      if (drag) { drag = null; report(); }
      try { bar.releasePointerCapture(e.pointerId); } catch (err) {}
    });

    // resize
    const rz = $('.win-resize', root);
    let rs = null;
    rz.addEventListener('pointerdown', (e) => {
      if (win.maximized) return;
      e.stopPropagation();
      rs = { x: e.clientX, y: e.clientY, w: win.rect.width, h: win.rect.height };
      rz.setPointerCapture(e.pointerId);
    });
    rz.addEventListener('pointermove', (e) => {
      if (!rs) return;
      win.rect.width = Math.max(340, rs.w + e.clientX - rs.x);
      win.rect.height = Math.max(190, rs.h + e.clientY - rs.y);
      applyRect(win);
    });
    rz.addEventListener('pointerup', (e) => {
      rs = null;
      try { rz.releasePointerCapture(e.pointerId); } catch (err) {}
      report();
    });
  }

  /* ---------------- taskbar / start menu / icons ---------------- */
  function syncTaskbar() {
    const list = $('#tasklist');
    if (!list) return;
    list.innerHTML = '';
    open_.forEach(w => {
      const b = el('button', 'task' + (w.id === focusedId && !w.minimized ? ' active' : ''));
      b.dataset.id = w.id;
      b.dataset.app = w.app;
      b.innerHTML = `<span>${w.manifest.icon}</span><span class="t">${esc(w.title)}</span>`;
      b.onclick = () => {
        if (w.minimized) w.restore();
        else if (focusedId === w.id) w.minimize();
        else w.focus();
      };
      list.appendChild(b);
    });
  }

  function buildDesktop() {
    const box = $('#icons');
    box.innerHTML = '';
    ORDER.forEach(id => {
      const m = APPS[id];
      const d = el('div', 'dicon');
      d.dataset.app = id;
      d.innerHTML = `<span class="ic">${m.icon}</span><span class="nm">${esc(m.name)}</span>`;
      d.ondblclick = () => WebOS.open(id);
      d.onclick = () => { $$('.dicon').forEach(x => x.classList.remove('sel')); d.classList.add('sel'); };
      box.appendChild(d);
    });

    const sm = $('#sm-apps');
    sm.innerHTML = '';
    ORDER.forEach(id => {
      const m = APPS[id];
      const a = el('div', 'sm-app');
      a.dataset.app = id;
      a.innerHTML = `<span class="ic">${m.icon}</span><span>${esc(m.name)}</span>`;
      a.onclick = () => { WebOS.open(id); toggleStart(false); };
      sm.appendChild(a);
    });
  }

  function toggleStart(force) {
    const m = $('#startmenu');
    const show = force === undefined ? m.classList.contains('hidden') : force;
    m.classList.toggle('hidden', !show);
  }

  /* ---------------- toasts ---------------- */
  let toastSeq = 0;
  function notify(text, kind, title) {
    const t = el('div', 'toast ' + (kind || ''));
    t.dataset.id = 't' + (++toastSeq);
    t.innerHTML = (title ? `<b>${esc(title)}</b>` : '<b>notification</b>') + esc(text);
    $('#toasts').appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; t.style.transform = 'translateX(30px)'; setTimeout(() => t.remove(), 300); }, 5200);
    pushNotification(text, kind, title);
    return t;
  }
  const notifications = [];
  function pushNotification(text, kind, title) {
    notifications.push({ text: String(text), kind: kind || 'info', title: title || '', ts: Date.now() });
    if (notifications.length > 40) notifications.shift();
    report();
  }

  /* ---------------- modal prompt / confirm (sandbox-safe) ---------------- */
  function modal(html, { input = false, value = '', placeholder = '' } = {}) {
    return new Promise((resolve) => {
      const back = el('div', '');
      back.style.cssText = 'position:absolute;inset:0;background:rgba(4,6,12,.55);backdrop-filter:blur(3px);z-index:900;display:flex;align-items:center;justify-content:center';
      const box = el('div', '');
      box.style.cssText = 'width:min(420px,86vw);background:var(--surface-2);border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow);padding:18px';
      box.innerHTML = `<div style="font-size:13px;margin-bottom:12px">${esc(html)}</div>`;
      let inp = null;
      if (input) {
        inp = el('input', 'inp');
        inp.value = value; inp.placeholder = placeholder || '';
        inp.style.cssText = 'width:100%;margin-bottom:14px';
        box.appendChild(inp);
      }
      const row = el('div', '');
      row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end';
      const no = el('button', 'tb-btn', input ? 'Cancel' : 'No');
      const yes = el('button', 'tb-btn primary', input ? 'OK' : 'Yes');
      row.appendChild(no); row.appendChild(yes);
      box.appendChild(row);
      back.appendChild(box);
      $('#desktop').appendChild(back);
      const done = (v) => { back.remove(); document.removeEventListener('keydown', key); resolve(v); };
      const key = (e) => {
        if (e.key === 'Escape') done(null);
        if (e.key === 'Enter') done(input ? inp.value : true);
      };
      document.addEventListener('keydown', key);
      no.onclick = () => done(null);
      yes.onclick = () => done(input ? inp.value : true);
      back.onclick = (e) => { if (e.target === back) done(null); };
      setTimeout(() => { (inp || yes).focus(); if (inp) inp.select(); }, 40);
    });
  }
  /* ---------------- theme / wallpaper ---------------- */
  const WALLS = {
    'aurora': null,
    'deep space': 'radial-gradient(1000px 700px at 20% 15%, #10204f 0%, transparent 60%), linear-gradient(160deg,#05060a,#0d1120 60%,#05060a)',
    'violet': 'radial-gradient(900px 700px at 80% 20%, #5b2a8a 0%, transparent 55%), linear-gradient(200deg,#100818,#1b1030)',
    'sunset': 'linear-gradient(160deg,#2b1055,#7597de 60%,#ffb56b)',
    'forest': 'radial-gradient(1100px 700px at 25% 20%, #0f3d2e 0%, transparent 60%), linear-gradient(160deg,#05100c,#0d2420)',
    'paper': 'linear-gradient(160deg,#f7f9ff,#e6ebf7)'
  };
  function setWallpaper(css) {
    const wp = $('#wallpaper');
    document.documentElement.style.setProperty('--wall', css || '');
    wp.style.background = css || '';
    settings.wallpaper = css;
    store('wallpaper', css);
    report();
  }
  function setTheme(mode) {
    settings.theme = mode === 'light' ? 'light' : 'dark';
    document.body.className = 'theme-' + settings.theme;
    store('theme', settings.theme);
    report();
  }
  function setAccent(hex) {
    settings.accent = hex;
    document.documentElement.style.setProperty('--accent', hex);
    store('accent', hex);
    report();
  }

  /* ---------------- state reporting (for the agent) ---------------- */
  let reportTimer = null;
  function report() {
    if (reportTimer) return;
    reportTimer = setTimeout(() => {
      reportTimer = null;
      emit('state', WebOS.state());
    }, 120);
  }

  function winState(w) {
    return {
      id: w.id, app: w.app, title: w.title, focused: w.id === focusedId,
      minimized: !!w.minimized, maximized: !!w.maximized,
      rect: { left: Math.round(w.rect.left), top: Math.round(w.rect.top), width: Math.round(w.rect.width), height: Math.round(w.rect.height) }
    };
  }

  /* ---------------- command routing (used by bridge.js) ---------------- */
  function findWindow(target) {
    if (!target) return open_.find(w => w.id === focusedId && !w.minimized) || open_.filter(w => !w.minimized).slice(-1)[0];
    if (typeof target === 'string' && target.startsWith('w')) {
      const byId = open_.find(w => w.id === target);
      if (byId) return byId;
    }
    const appId = (target.app || target.appId || target.id || target);
    const matches = open_.filter(w => w.app === appId);
    return matches.length ? matches[matches.length - 1] : null;
  }

  async function handleCommand(cmd) {
    const op = String(cmd.op || '').toLowerCase();
    const args = cmd.args || {};
    const own = (extra) => Object.assign({ id: cmd.id, op, handledBy: 'kernel' }, extra || {});

    switch (op) {
      case 'open': {
        const appId = (cmd.app || args.app || args.id || '').toLowerCase();
        if (!APPS[appId]) return own({ ok: false, error: 'unknown app: ' + appId, available: ORDER });
        const w = WebOS.open(appId, args);
        return own({ ok: !!w, windowId: w && w.id, app: appId, title: w && w.title });
      }
      case 'close': {
        const w = findWindow(args.window || args.target || cmd.window || args.app);
        if (!w) return own({ ok: false, error: 'window not found' });
        w.close();
        return own({ ok: true, closed: w.id });
      }
      case 'closeall': {
        const n = open_.length;
        [...open_].forEach(w => w.close());
        return own({ ok: true, closed: n });
      }
      case 'focus': {
        const w = findWindow(args.window || args.target || args.app);
        if (!w) return own({ ok: false, error: 'window not found' });
        w.focus();
        return own({ ok: true, windowId: w.id, app: w.app });
      }
      case 'minimize': {
        const w = findWindow(args.window || args.app);
        if (!w) return own({ ok: false, error: 'window not found' });
        w.minimize();
        return own({ ok: true, windowId: w.id });
      }
      case 'maximize': case 'restore': {
        const w = findWindow(args.window || args.app);
        if (!w) return own({ ok: false, error: 'window not found' });
        if (op === 'maximize') w.maximize(args.on === undefined ? true : args.on);
        else { w.minimized = false; w.el.classList.remove('min'); w.maximize(false); w.focus(); }
        return own({ ok: true, windowId: w.id, maximized: w.maximized });
      }
      case 'move': {
        const w = findWindow(args.window || args.app);
        if (!w) return own({ ok: false, error: 'window not found' });
        ['left', 'top', 'width', 'height'].forEach(k => { if (typeof args[k] === 'number') w.rect[k] = args[k]; });
        w.applyRect();
        report();
        return own({ ok: true, windowId: w.id, rect: w.rect });
      }
      case 'windows': case 'list':
        return own({ ok: true, windows: open_.map(winState) });
      case 'notify':
        notify(args.text || args.message || 'notification', args.kind || 'ok', args.title);
        return own({ ok: true, text: args.text || '' });
      case 'wallpaper':
        setWallpaper(args.css || args.wallpaper || args.value);
        return own({ ok: true, wallpaper: settings.wallpaper });
      case 'theme':
        if (args.accent) setAccent(args.accent);
        if (args.mode || args.theme) setTheme(args.mode || args.theme);
        return own({ ok: true, theme: settings.theme, accent: settings.accent });
      case 'titlebar': {
        const w = findWindow(args.window || args.app);
        if (!w) return own({ ok: false, error: 'window not found' });
        w.setTitle(args.title || w.title);
        return own({ ok: true });
      }
      case 'apps':
        return own({ ok: true, apps: ORDER.map(id => ({ id, name: APPS[id].name, icon: APPS[id].icon })) });
    }

    // app-specific ops (navigate / back / click / type / read / ...)
    const preferredApp = cmd.app || args.app;
    let target = null;
    if (preferredApp) target = open_.filter(w => w.app === preferredApp).slice(-1)[0];
    if (!target) target = open_.find(w => w.id === focusedId);
    if (!target) target = open_.slice(-1)[0];

    if (target && target.instance && target.instance.handleCommand) {
      try {
        const res = await target.instance.handleCommand(cmd, target);
        if (res) return Object.assign({ id: cmd.id, op, handledBy: target.app, windowId: target.id }, res);
      } catch (e) {
        return own({ ok: false, error: 'app error: ' + e.message });
      }
    }

    // generic DOM ops fallback (click/type/query inside the OS itself)
    if (['click', 'type', 'query', 'key'].includes(op)) {
      return own(domCommand(op, args));
    }

    return own({ ok: false, error: 'unknown op: ' + op, openWindows: open_.map(w => w.app) });
  }

  function domCommand(op, args) {
    const sel = args.selector || args.sel;
    try {
      if (op === 'click') {
        const node = sel ? document.querySelector(sel) : null;
        if (!node) return { ok: false, error: 'selector not found: ' + sel };
        node.click();
        return { ok: true, clicked: sel };
      }
      if (op === 'type') {
        const node = sel ? document.querySelector(sel) : null;
        if (!node) return { ok: false, error: 'selector not found: ' + sel };
        node.focus();
        if ('value' in node) {
          node.value = String(args.text || '');
          node.dispatchEvent(new Event('input', { bubbles: true }));
          node.dispatchEvent(new Event('change', { bubbles: true }));
          if (args.submit) {
            const ev = new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true });
            node.dispatchEvent(ev);
            if (node.form && node.form.requestSubmit) { try { node.form.requestSubmit(); } catch (e) {} }
          }
        }
        return { ok: true, typed: sel };
      }
      if (op === 'query') {
        const nodes = sel ? Array.from(document.querySelectorAll(sel)) : [];
        return {
          ok: true, count: nodes.length,
          items: nodes.slice(0, 60).map(n => ({
            tag: n.tagName.toLowerCase(), text: (n.innerText || n.value || '').slice(0, 200).trim(),
            rect: (() => { const r = n.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; })()
          }))
        };
      }
      if (op === 'key') {
        const target = document.activeElement || document.body;
        const k = args.key || 'Enter';
        target.dispatchEvent(new KeyboardEvent('keydown', { key: k, keyCode: args.keyCode || 13, bubbles: true }));
        target.dispatchEvent(new KeyboardEvent('keyup', { key: k, bubbles: true }));
        return { ok: true, key: k };
      }
    } catch (e) { return { ok: false, error: e.message }; }
    return { ok: false, error: 'unsupported dom op' };
  }

  /* ---------------- boot ---------------- */
  function boot() {
    const sTheme = store('theme'); if (sTheme) settings.theme = sTheme;
    const sWall = store('wallpaper'); if (sWall) settings.wallpaper = sWall;
    const sAccent = store('accent'); if (sAccent) settings.accent = sAccent;
    setTheme(settings.theme);
    setAccent(settings.accent);
    if (settings.wallpaper && !Object.prototype.hasOwnProperty.call(WALLS, settings.wallpaper)) setWallpaper(settings.wallpaper);

    buildDesktop();
    $('#startBtn').onclick = () => toggleStart();
    $('#themeBtn').onclick = () => setTheme(settings.theme === 'dark' ? 'light' : 'dark');
    $('#smLock').onclick = () => location.reload();
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#startmenu') && !e.target.closest('#startBtn')) toggleStart(false);
    });
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.code === 'Space') { e.preventDefault(); toggleStart(); }
      if (e.ctrlKey && e.key.toLowerCase() === 'w' && focusedId) { e.preventDefault(); const w = open_.find(x => x.id === focusedId); if (w) w.close(); }
    });
    setInterval(() => { $('#clock').textContent = nowTime(); }, 1000);
    $('#clock').textContent = nowTime();
    window.addEventListener('resize', () => {
      const dr = desktopRect();
      open_.forEach(w => {
        if (w.maximized) { w.rect.width = dr.w; w.rect.height = dr.h; applyRect(w); }
        else {
          w.rect.left = Math.min(w.rect.left, Math.max(0, dr.w - 120));
          w.rect.top = Math.min(w.rect.top, Math.max(0, dr.h - 60));
          w.rect.width = Math.min(w.rect.width, dr.w);
          w.rect.height = Math.min(w.rect.height, dr.h);
          applyRect(w);
        }
      });
    });

    // welcome layout: browser + agent console side by side
    setTimeout(() => {
      const dr = desktopRect();
      const browser = WebOS.open('browser', { url: 'https://example.com' });
      if (browser) {
        browser.rect = { left: 12, top: 10, width: Math.round(dr.w * 0.66), height: Math.round(dr.h - 24) };
        browser.applyRect(); browser.focus();
      }
      const agent = WebOS.open('agent');
      if (agent) {
        agent.rect = { left: Math.round(dr.w * 0.66) + 22, top: 10, width: Math.round(dr.w * 0.32) - 24, height: Math.round((dr.h - 24) * 0.52) };
        agent.applyRect();
      }
    }, 260);

    if (window.WEBOS_LOCAL) {
      WebOS.notify('Local mode — sab kuch browser ke andar. Console me WebOS.handleCommand({op:"open",app:"files"}) try karo.', 'ok', 'WebOS 1.0 (single file)');
    } else {
      WebOS.notify('Agent bus ready. /api/agent/cmd se OS control karo.', 'ok', 'WebOS 1.0');
    }
    emit('boot');
  }

  /* ---------------- public kernel object ---------------- */
  const WebOS = {
    version: '1.0.0',
    boot, registerApp, open: createWindow, notify, api, on, emit,
    settings, WALLS,
    setTheme, setWallpaper, setAccent,
    handleCommand,
    toggleStart,
    get windows() { return open_.map(winState); },
    get instances() { return open_; },
    focused() { return open_.find(w => w.id === focusedId) || null; },
    findWindow,
    report,
    state() {
      const feed = {};
      open_.forEach(w => {
        if (w.instance && typeof w.instance.state === 'function') {
          try { feed[w.app] = w.instance.state(); } catch (e) { feed[w.app] = { error: e.message }; }
        }
      });
      return {
        os: 'WebOS', version: '1.0.0',
        theme: settings.theme, accent: settings.accent,
        wallpaper: settings.wallpaper,
        focused: focusedId,
        windows: open_.map(winState),
        apps: ORDER.map(id => ({ id, name: APPS[id].name, icon: APPS[id].icon })),
        desktopIcons: ORDER.map(id => ({ app: id, name: APPS[id].name, selector: `.dicon[data-app="${id}"]` })),
        notifications: notifications.slice(-10),
        appState: feed,
        ts: Date.now()
      };
    }
  };

  WebOS.prompt = (text, value, placeholder) => modal(text, { input: true, value: value || '', placeholder });
  WebOS.confirm = (text) => modal(text, { input: false }).then(v => !!v);
  WebOS.modal = modal;

  window.WebOS = WebOS;
})();
