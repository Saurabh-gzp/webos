/* ============================================================
   WebOS Browser — real web browsing inside the OS + agent control
   Agent ops: navigate, back, forward, reload, read, click, type,
              scroll, eval, tabs, panel
   ============================================================ */
(function () {
  'use strict';

  const SEARCH_ENGINE = 'https://duckduckgo.com/?q=';
  const SANDBOX = 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads allow-top-navigation-by-user-activation';

  /* ---------- small helpers ---------- */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function mk(tag, cls, html) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }
  function looksLikeUrl(s) {
    s = String(s || '').trim();
    if (!s) return false;
    if (/^(https?:\/\/|webos:\/\/)/i.test(s)) return true;
    if (/^localhost(:\d+)?(\/|$)/i.test(s)) return true;
    if (/^[\w-]+(\.[\w-]+)+(\/|:|$)/.test(s) && !/\s/.test(s)) return true;
    return false;
  }
  function normalizeUrl(s) {
    s = String(s || '').trim();
    if (!s) return 'webos://start';
    if (/^(https?:\/\/|webos:\/\/)/i.test(s)) return s;
    if (/^localhost(:\d+)?(\/|$)/i.test(s)) return 'http://' + s;
    if (looksLikeUrl(s)) return 'https://' + s;
    return SEARCH_ENGINE + encodeURIComponent(s);
  }
  function realUrl(u) {
    try {
      const parsed = new URL(u, location.href);
      if (parsed.pathname === '/api/proxy' && parsed.searchParams.get('url')) return parsed.searchParams.get('url');
      return u;
    } catch (e) { return u; }
  }
  function hostOf(u) {
    try { return new URL(u).host.replace(/^www\./, ''); } catch (e) { return String(u || '').slice(0, 40); }
  }
  function localMode() { return !!window.WEBOS_LOCAL; }
  function proxyUrl(u) {
    // local (single-file) build: load the page straight from the internet
    if (localMode()) return u;
    return '/api/proxy?url=' + encodeURIComponent(u);
  }

  /* ---------- mini bridge injected into our own srcdoc pages ---------- */
  function miniBridge() {
    return `<script data-webos-bridge>(function(){
  if (window.__webosBridge) return; window.__webosBridge = true;
  function send(m){ try { parent.postMessage(Object.assign({__webos:true}, m), '*'); } catch(e){} }
  function abs(u){ try { return new URL(u, document.baseURI).href; } catch(e){ return u; } }
  function txt(e){ return (e.innerText||e.textContent||'').replace(/\\s+/g,' ').trim(); }
  function vis(e){ if(!e) return false; var s=getComputedStyle(e); if(s.display==='none'||s.visibility==='hidden') return false; var r=e.getBoundingClientRect(); return !(r.width<1&&r.height<1); }
  var refMap = new WeakMap(), nextRef = 1;
  function refOf(e){ var r = refMap.get(e); if(!r){ r = nextRef++; refMap.set(e,r); } try{ e.setAttribute('data-webos-ref', String(r)); }catch(err){} return r; }
  function elements(){
    var out=[];
    function add(e,kind){ var r=e.getBoundingClientRect();
      out.push({ref:refOf(e),kind:kind,tag:e.tagName.toLowerCase(),text:(kind==='input'?(e.value||e.placeholder||''):txt(e)).slice(0,180),href:e.href||undefined,rect:[Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)]});
    }
    document.querySelectorAll('a[href]').forEach(function(a){ if(vis(a)&&txt(a)) add(a,'link'); });
    document.querySelectorAll('button,[role=button],input[type=submit],input[type=button]').forEach(function(b){ if(vis(b)) add(b,'button'); });
    document.querySelectorAll('input:not([type=submit]):not([type=button]),textarea,select').forEach(function(i){ if(vis(i)) add(i,'input'); });
    return out.slice(0,400);
  }
  function snapshot(){
    send({type:'page', url: (location.href==='about:srcdoc'? 'webos://start' : location.href), title: document.title||'',
      text: (document.body? (document.body.innerText||document.body.textContent||'') : '').replace(/\\n{3,}/g,'\\n\\n').trim().slice(0,60000),
      elements: elements(), ts: Date.now()});
  }
  function clickRef(ref){ var e=document.querySelector('[data-webos-ref="'+ref+'"]'); if(!e) return false; e.scrollIntoView({block:'center'}); e.click(); return true; }
  function typeRef(ref,v,submit){ var e=document.querySelector('[data-webos-ref="'+ref+'"]'); if(!e) return false;
    e.scrollIntoView({block:'center'}); try{e.focus();}catch(err){}
    if(e.tagName==='SELECT'){ e.value=v; } else { e.value=String(v); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); }
    if(submit){ var f=e.form||(e.closest&&e.closest('form')); if(f){ try{ f.requestSubmit?f.requestSubmit():f.submit(); }catch(err){ try{f.submit();}catch(e2){} } }
      else { e.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',keyCode:13,which:13,bubbles:true})); } }
    return true; }
  document.addEventListener('click', function(ev){
    var a = ev.target && ev.target.closest ? ev.target.closest('a[href]') : null; if(!a) return;
    var href = a.getAttribute('href')||''; if(!href || href.charAt(0)==='#') return;
    ev.preventDefault(); ev.stopPropagation(); send({type:'navigate', url: abs(href), newTab: a.target==='_blank'});
  }, true);
  window.addEventListener('message', function(ev){
    var d=ev.data||{};
    if(d.__webosSetBase) { try{ document.baseURI; }catch(e){} }
  });
  document.addEventListener('submit', function(ev){
    var f=ev.target; if(!f||f.tagName!=='FORM') return; ev.preventDefault();
    var method=(f.method||'GET').toUpperCase(); var data=new URLSearchParams(new FormData(f)).toString();
    var orig=f.getAttribute('data-webos-action');
    var action = orig ? abs(orig) : (f.getAttribute('action') ? abs(f.getAttribute('action')) : abs(f.getAttribute('data-webos-real')||parent.location.href));
    if(method==='GET') action += (action.indexOf('?')>=0?'&':'?')+data;
    send({type:'form', url:action, method:method, data:data});
  }, true);
  window.open = function(u){ send({type:'navigate', url: abs(u||''), newTab:true}); return null; };
  window.addEventListener('message', function(ev){
    var d=ev.data||{}; if(!d.__webosCmd) return; var res={ok:false};
    try{
      if(d.op==='snapshot'){ snapshot(); return; }
      if(d.op==='click') res.ok=clickRef(d.ref);
      else if(d.op==='type') res.ok=typeRef(d.ref, d.text, d.submit);
      else if(d.op==='scroll'){ window.scrollBy(0,d.y||600); res.ok=true; }
      else if(d.op==='scrollTo'){ window.scrollTo(0,d.y||0); res.ok=true; }
      else if(d.op==='select'){ var e=document.querySelector('[data-webos-ref="'+d.ref+'"]'); if(e){e.scrollIntoView({block:'center'}); e.style.outline='3px solid #ff9d00'; setTimeout(function(){e.style.outline='';},1200); res.ok=true;} }
      else if(d.op==='eval'){ res.value=String(eval(d.code)); res.ok=true; }
    }catch(e){ res.error=String(e&&e.message||e); }
    if(d.replyId) send({type:'cmdResult', replyId:d.replyId, result:res});
  });
  setTimeout(snapshot, 60);
  window.addEventListener('load', function(){ setTimeout(snapshot, 180); });
  setInterval(snapshot, 3000);
})();<\/script>`;
  }

  function startPage() {
    const links = [
      ['example.com', 'https://example.com', '🌐'],
      ['wikipedia.org', 'https://en.wikipedia.org/wiki/Operating_system', '📚'],
      ['news.ycombinator', 'https://news.ycombinator.com', '📰'],
      ['duckduckgo', 'https://duckduckgo.com', '🦆'],
      ['github.com', 'https://github.com', '🐙'],
      ['developer.mozilla', 'https://developer.mozilla.org', '🦊']
    ];
    return `<!doctype html><html><head><meta charset="utf-8"><title>New Tab — WebOS</title>
<style>
 body{margin:0;font-family:ui-sans-serif,system-ui,sans-serif;background:radial-gradient(900px 600px at 20% 10%,#1b2a5e,#0b0e16 60%);color:#e9edf7;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:22px}
 .logo{font-size:44px;color:#7c9cff;text-shadow:0 0 30px rgba(124,156,255,.7)}
 h1{font-size:22px;margin:0;letter-spacing:.04em}
 p.mut{color:#8d96b5;font-size:12.5px;margin:0}
 form{display:flex;gap:8px;width:min(560px,86vw)}
 input{flex:1;height:42px;border-radius:12px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.07);color:#fff;padding:0 14px;font-size:14px;outline:none}
 input:focus{border-color:#6b8cff;box-shadow:0 0 0 4px rgba(107,140,255,.18)}
 button{height:42px;padding:0 18px;border-radius:12px;border:0;background:linear-gradient(135deg,#6b8cff,#a678ff);color:#fff;font-weight:600;cursor:pointer}
 .grid{display:grid;grid-template-columns:repeat(3,minmax(120px,1fr));gap:10px;width:min(620px,88vw)}
 a.card{display:flex;flex-direction:column;gap:6px;padding:12px;border-radius:12px;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.045);text-decoration:none;color:#e9edf7;font-size:12.5px}
 a.card:hover{background:rgba(107,140,255,.2);border-color:rgba(107,140,255,.4)}
 .hint{font-size:11px;color:#697089}
</style></head><body>
<div class="logo">◈</div>
<h1>WebOS Browser</h1>
<p class="mut">Kuch bhi search karo, ya website kholo — sab kuch OS ke andar chalega</p>
<form id="f"><input id="q" placeholder="search karo ya URL paste karo…" autocomplete="off"><button>Go</button></form>
<div class="grid">
 ${links.map(([n, u, i]) => `<a class="card" href="${u}"><span style="font-size:18px">${i}</span>${esc(n)}</a>`).join('')}
</div>
<p class="hint">Agent isi page ko bhi padh aur click kar sakta hai — refs Elements panel me dikhte hain</p>
<script>
 document.getElementById('f').addEventListener('submit', function(e){
   e.preventDefault();
   var v = document.getElementById('q').value;
   var url = /^(https?:\\/\\/|webos:\\/\\/)/.test(v) || /^[\\w-]+(\\.[\\w-]+)+/.test(v) ? v : 'webos://search?q=' + encodeURIComponent(v);
   parent.postMessage({__webos:true, type:'navigate', url:url}, '*');
 });
<\/script>
${miniBridge()}
</body></html>`;
  }

  function searchPage(query, results, engine) {
    const rows = (results || []).map(r => `
      <a class="r" href="${esc(r.url)}">
        <span class="t">${esc(r.title)}</span>
        <span class="u">${esc(r.url)}</span>
        ${r.snippet ? `<span class="s">${esc(r.snippet)}</span>` : ''}
      </a>`).join('');
    return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(query)} — WebOS Search</title>
<style>
 body{margin:0;font-family:ui-sans-serif,system-ui,sans-serif;background:#0e1119;color:#e9edf7}
 header{position:sticky;top:0;background:rgba(14,17,25,.95);border-bottom:1px solid rgba(255,255,255,.08);padding:12px 16px;display:flex;gap:10px;align-items:center}
 input{flex:1;height:36px;border-radius:10px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.06);color:#fff;padding:0 12px;outline:none}
 button{height:36px;padding:0 14px;border-radius:10px;border:0;background:#6b8cff;color:#fff;font-weight:600;cursor:pointer}
 main{padding:14px 16px;max-width:820px}
 .meta{color:#8d96b5;font-size:11.5px;margin-bottom:12px}
 .r{display:block;padding:12px 14px;border-radius:10px;border:1px solid rgba(255,255,255,.08);margin-bottom:9px;text-decoration:none;color:#dfe6f7;background:rgba(255,255,255,.03)}
 .r:hover{background:rgba(107,140,255,.16);border-color:rgba(107,140,255,.4)}
 .r .t{display:block;font-size:14.5px;color:#9dbcff;margin-bottom:3px}
 .r .u{display:block;font-size:11px;color:#6f7896;word-break:break-all;margin-bottom:5px}
 .r .s{display:block;font-size:12.5px;color:#c3cbdf}
</style></head><body>
<header>
  <b style="font-size:13px;color:#7c9cff">◈</b>
  <input id="q" value="${esc(query)}">
  <button id="go">Search</button>
</header>
<main>
  <div class="meta">${results ? results.length : 0} results for “${esc(query)}”${engine ? ' · engine: ' + esc(engine) : ''}</div>
  ${rows || '<div class="meta">Koi result nahi mila. Dusra query try karo.</div>'}
</main>
<script>
 function go(){ var v=document.getElementById('q').value.trim(); if(!v) return; parent.postMessage({__webos:true,type:'navigate',url:'webos://search?q='+encodeURIComponent(v)},'*'); }
 document.getElementById('go').onclick = go;
 document.getElementById('q').addEventListener('keydown', function(e){ if(e.key==='Enter') go(); });
<\/script>
${miniBridge()}
</body></html>`;
  }

  /* ================= app ================= */
  WebOS.registerApp({
    id: 'browser',
    name: 'Browser',
    icon: '🌐',
    width: 1120,
    height: 720,

    mount(a) {
      const root = a.win.body;
      let tabs = [];
      let tabSeq = 0;
      let activeId = null;
      let panelMode = null; // 'elements' | 'text' | 'tools'

      /* ---- DOM ---- */
      const tabbar = mk('div', 'tabs');
      const toolbar = mk('div', 'toolbar');
      toolbar.innerHTML = `
        <button class="tb-btn" data-act="back" title="Back (Alt+←)">‹</button>
        <button class="tb-btn" data-act="fwd" title="Forward">›</button>
        <button class="tb-btn" data-act="reload" title="Reload (F5)">⟳</button>
        <button class="tb-btn" data-act="home" title="Home">⌂</button>
        <input class="inp" id="omni" placeholder="URL ya search… (Ctrl+K)" autocomplete="off" spellcheck="false">
        <button class="tb-btn primary" data-act="go">Go</button>
        <button class="tb-btn" data-act="panel" title="Toggle side panel">☰</button>
        <button class="tb-btn" data-act="chromium" title="Asli Chromium me kholo (X-Frame-Options wali sites bhi chalti hain)">🌐</button>`;
      const frameBox = mk('div', 'br-frame');
      const progress = mk('div', 'br-progress');
      frameBox.appendChild(progress);
      const panel = mk('div', 'br-side hide');

      const split = mk('div', 'split');
      split.appendChild(frameBox);
      split.appendChild(panel);

      const status = mk('div', 'statusbar');
      status.innerHTML = `<span id="stUrl">webos://start</span><span id="stInfo"></span>`;

      root.appendChild(tabbar);
      root.appendChild(toolbar);
      root.appendChild(split);
      root.appendChild(status);

      const omni = toolbar.querySelector('#omni');
      const stUrl = status.querySelector('#stUrl');
      const stInfo = status.querySelector('#stInfo');

      /* ---- tabs ---- */
      function activeTab() { return tabs.find(t => t.id === activeId) || null; }

      function createTab(url, opts = {}) {
        const id = 't' + (++tabSeq);
        const wrap = mk('div', 'br-tabview');
        const iframe = document.createElement('iframe');
        iframe.setAttribute('sandbox', SANDBOX);
        iframe.setAttribute('referrerpolicy', 'no-referrer');
        iframe.name = 'webframe_' + id;
        iframe.dataset.tab = id;
        const loadingEl = mk('div', 'br-loading', '<span class="spin"></span><span>booting…</span>');
        loadingEl.style.display = 'none';
        wrap.appendChild(iframe);
        wrap.appendChild(loadingEl);
        wrap.style.display = 'none';
        frameBox.appendChild(wrap);
        const tab = {
          id, iframe, wrap, loadingEl, url: url || 'webos://start', title: 'New Tab', history: [], hi: -1,
          loading: false, elements: [], text: '', pageTitle: '', lastSnapshot: 0, loadStart: 0, loadWaiters: []
        };
        tabs.push(tab);
        iframe.addEventListener('load', () => onFrameLoad(tab));
        setActive(tab.id);
        navigate(tab, tab.url, { replace: true, skipHistory: false });
        renderTabs();
        return tab;
      }

      function closeTab(id) {
        const i = tabs.findIndex(t => t.id === id);
        if (i < 0) return;
        const [t] = tabs.splice(i, 1);
        try { t.wrap.remove(); } catch (e) {}
        if (activeId === id) {
          const next = tabs[i] || tabs[i - 1] || null;
          if (next) setActive(next.id); else createTab('webos://start');
        }
        renderTabs(); publish();
      }

      function setActive(id) {
        activeId = id;
        tabs.forEach(t => { t.wrap.style.display = t.id === id ? 'block' : 'none'; });
        renderTabs(); syncToolbar(); publish();
      }

      function renderTabs() {
        tabbar.innerHTML = '';
        tabs.forEach(t => {
          const d = mk('div', 'tab' + (t.id === activeId ? ' active' : ''));
          d.dataset.tab = t.id;
          d.innerHTML = `<span class="t">${esc(t.loading ? '… ' : '')}${esc(t.title || 'New Tab')}</span><span class="x" data-close="${t.id}">✕</span>`;
          d.onclick = (e) => {
            if (e.target.dataset.close) { closeTab(e.target.dataset.close); return; }
            setActive(t.id);
          };
          tabbar.appendChild(d);
        });
        const plus = mk('div', 'tab', '<span class="t">＋</span>');
        plus.style.maxWidth = '46px';
        plus.title = 'New tab (Ctrl+T)';
        plus.onclick = () => createTab('webos://start');
        tabbar.appendChild(plus);
      }

      function syncToolbar() {
        const t = activeTab();
        if (!t) return;
        if (document.activeElement !== omni) omni.value = t.url === 'webos://start' ? '' : t.url;
        toolbar.querySelector('[data-act="back"]').disabled = t.hi <= 0;
        toolbar.querySelector('[data-act="fwd"]').disabled = t.hi >= t.history.length - 1;
        stUrl.textContent = t.url;
        stInfo.textContent = localMode()
          ? 'local mode • direct load • agent refs ke liye server chalao'
          : `${t.elements.length} elements • ${t.text.length} chars • ${t.loading ? 'loading' : 'ready'}`;
      }

      /* ---- navigation ---- */
      async function navigate(tab, url, opts = {}) {
        if (!tab) return false;
        url = String(url || '').trim();
        if (!url) return false;

        if (/^webos:\/\/search\?q=/i.test(url)) {
          const q = decodeURIComponent(url.split('q=')[1] || '');
          return doSearch(tab, q, opts);
        }

        // internal start page
        if (/^webos:\/\/(start|home|newtab)$/i.test(url) || url === '') {
          tab.url = 'webos://start';
          tab.title = 'New Tab';
          tab.loading = true;
          progress.classList.add('on');
          tab.elements = []; tab.text = ''; tab.pageTitle = '';
          tab.loadStart = Date.now();
          tab.pendingTarget = null;
          tab.navSettled = true;
          if (!opts.skipHistory) {
            tab.history = tab.history.slice(0, tab.hi + 1);
            tab.history.push(tab.url);
            tab.hi = tab.history.length - 1;
          }
          tab.loadingEl.innerHTML = '<span class="spin"></span><span>new tab</span>';
          tab.loadingEl.style.display = 'flex';
          tab.iframe.removeAttribute('src');
          tab.iframe.srcdoc = startPage();
          renderTabs(); syncToolbar(); publish();
          const ok0 = await waitForLoad(tab, opts.timeout || 8000);
          return ok0;
        }

        const real = normalizeUrl(url);
        tab.url = real;
        tab.title = hostOf(real);
        tab.loading = true;
        tab.elements = [];
        tab.text = '';
        tab.pageTitle = '';
        tab.loadStart = Date.now();
        tab.pendingTarget = real;
        tab.navSettled = false;
        progress.classList.add('on');

        if (!opts.skipHistory) {
          tab.history = tab.history.slice(0, tab.hi + 1);
          if (tab.history[tab.history.length - 1] !== real) tab.history.push(real);
          tab.hi = tab.history.length - 1;
        } else if (tab.hi < 0) {
          tab.history = [real]; tab.hi = 0;
        }

        tab.loadingEl.innerHTML = '<span class="spin"></span><span>loading ' + esc(hostOf(real)) + '…</span>';
        tab.loadingEl.style.display = 'flex';

        tab.iframe.removeAttribute('srcdoc');
        tab.iframe.src = proxyUrl(real);
        renderTabs(); syncToolbar(); publish();

        const ok = await waitForLoad(tab, opts.timeout || (localMode() ? 8000 : 20000));
        publish();
        return ok;
      }

      async function doSearch(tab, query, opts = {}) {
        if (localMode()) {
          // no server -> no /api/search. Just hand the query to the engine itself.
          return navigate(tab, 'https://duckduckgo.com/?q=' + encodeURIComponent(query), { skipHistory: opts.skipHistory });
        }
        tab.loading = true; progress.classList.add('on');
        tab.url = 'webos://search?q=' + encodeURIComponent(query);
        tab.title = '🔍 ' + query;
        if (!opts.skipHistory) {
          tab.history = tab.history.slice(0, tab.hi + 1);
          tab.history.push(tab.url);
          tab.hi = tab.history.length - 1;
        }
        tab.loadingEl.innerHTML = '<span class="spin"></span><span>searching…</span>';
        tab.loadingEl.style.display = 'flex';
        let results = [], engine = null;
        try {
          const r = await WebOS.api.search(query);
          results = r.results || [];
          engine = r.engine;
        } catch (e) {}
        tab.iframe.removeAttribute('src');
        tab.iframe.srcdoc = searchPage(query, results, engine);
        tab.pendingTarget = null;
        tab.searchResults = results;
        tab.lastUrl = tab.url;
        setTimeout(() => { tab.loading = false; progress.classList.remove('on'); tab.loadingEl.style.display = 'none'; renderTabs(); syncToolbar(); publish(); }, 400);
        renderTabs(); syncToolbar(); publish();
        return { ok: true, url: tab.url, results: results.length, engine };
      }

      function waitForLoad(tab, timeout) {
        return new Promise((resolve) => {
          let done = false;
          const finish = (v) => {
            if (done) return;
            done = true;
            tab.loading = false;
            progress.classList.remove('on');
            tab.loadingEl.style.display = 'none';
            renderTabs(); syncToolbar(); publish();
            resolve(v);
          };
          tab.loadWaiters.push(finish);
          setTimeout(() => finish(true), timeout || 20000);
        });
      }

      function onFrameLoad(tab) {
        // wait until the page's own bridge reports a fresh snapshot (or give up after ~2.6s)
        let waited = 0;
        const check = () => {
          const fresh = tab.navSettled === true;
          if (fresh || waited >= 3200) {
            const waiters = tab.loadWaiters.splice(0);
            tab.loading = false;
            progress.classList.remove('on');
            tab.loadingEl.style.display = 'none';
            waiters.forEach(w => w(true));
            renderTabs(); syncToolbar(); publish();
            return;
          }
          waited += 200;
          setTimeout(check, 200);
        };
        setTimeout(check, 220);
      }

      function goBack(tab) {
        tab = tab || activeTab();
        if (!tab || tab.hi <= 0) return false;
        tab.hi--; navigate(tab, tab.history[tab.hi], { skipHistory: true });
        return true;
      }
      function goForward(tab) {
        tab = tab || activeTab();
        if (!tab || tab.hi >= tab.history.length - 1) return false;
        tab.hi++; navigate(tab, tab.history[tab.hi], { skipHistory: true });
        return true;
      }

      /* ---- message bus from pages ---- */
      window.addEventListener('message', (ev) => {
        const d = ev.data || {};
        if (!d.__webos) return;
        const tab = tabs.find(t => t.iframe.contentWindow === ev.source);
        if (!tab) return;
        if (d.type === 'page') {
          tab.pageTitle = d.title || tab.pageTitle;
          tab.text = d.text || '';
          tab.elements = d.elements || [];
          const ru = realUrl(d.url);
          if (ru && !/^webos:/.test(ru) && !/^about:/.test(ru)) {
            tab.url = ru;
            if (!tab.history.length || tab.history[tab.hi] !== ru) { tab.history = tab.history.slice(0, tab.hi + 1); tab.history.push(ru); tab.hi = tab.history.length - 1; }
          }
          tab.title = d.title ? d.title.slice(0, 60) : tab.title;
          tab.lastSnapshot = Date.now();
          if (tab.pendingTarget) {
            try {
              const a = new URL(ru || tab.url), b = new URL(tab.pendingTarget);
              if (a.host && a.host === b.host) { tab.navSettled = true; tab.pendingTarget = null; }
            } catch (e) {
              tab.navSettled = true; tab.pendingTarget = null;
            }
          }
          if (tab.id === activeId) { syncToolbar(); renderPanel(); }
          renderTabs(); publish();
          return;
        }
        if (d.type === 'navigate') {
          if (d.newTab) createTab(d.url); else navigate(activeTab() === tab ? tab : tab, d.url);
          return;
        }
        if (d.type === 'form') {
          if (d.method === 'POST') {
            const f = document.createElement('form');
            f.method = 'POST';
            f.action = '/api/proxy?url=' + encodeURIComponent(d.url);
            f.target = tab.iframe.name;
            f.style.display = 'none';
            new URLSearchParams(d.data).forEach((v, k) => {
              const i = document.createElement('input'); i.name = k; i.value = v; f.appendChild(i);
            });
            document.body.appendChild(f);
            f.submit();
            setTimeout(() => f.remove(), 1500);
          } else {
            navigate(tab, d.url);
          }
          return;
        }
        if (d.type === 'cmdResult') {
          const p = pendingReplies.get(d.replyId);
          if (p) { clearTimeout(p.timer); pendingReplies.delete(d.replyId); p.resolve(d.result || { ok: false }); }
          return;
        }
      });

      /* ---- page commands (agent) ---- */
      const pendingReplies = new Map();
      let replySeq = 0;
      function pageCmd(tab, op, payload, timeout = 6000) {
        tab = tab || activeTab();
        if (!tab) return Promise.resolve({ ok: false, error: 'no tab' });
        const replyId = 'r' + (++replySeq);
        return new Promise((resolve) => {
          const timer = setTimeout(() => { pendingReplies.delete(replyId); resolve({ ok: false, error: 'page did not respond (cross-origin page?)' }); }, timeout);
          pendingReplies.set(replyId, { resolve, timer });
          try {
            tab.iframe.contentWindow.postMessage({ __webosCmd: true, op, replyId, ...payload }, '*');
          } catch (e) {
            clearTimeout(timer); pendingReplies.delete(replyId);
            resolve({ ok: false, error: e.message });
          }
        });
      }

      /* ---- side panel ---- */
      function togglePanel(mode) {
        panelMode = mode === undefined ? (panelMode ? null : 'elements') : (panelMode === mode ? null : mode);
        panel.classList.toggle('hide', !panelMode);
        renderPanel();
        publish();
      }

      function renderPanel() {
        if (!panelMode) return;
        const t = activeTab();
        panel.innerHTML = '';
        const pt = mk('div', 'panel-tabs');
        [['elements', 'Elements'], ['text', 'Text'], ['tools', 'Tools']].forEach(([m, label]) => {
          const b = mk('button', panelMode === m ? 'active' : '', label);
          b.onclick = () => { panelMode = m; renderPanel(); };
          pt.appendChild(b);
        });
        panel.appendChild(pt);
        const body = mk('div', 'panel-body');

        if (!t) {
          body.innerHTML = '<div class="empty">no tab</div>';
          panel.appendChild(body);
          return;
        }

        if (panelMode === 'elements') {
          if (!t.elements.length) {
            body.innerHTML = `<div class="empty"><span class="big">🖱️</span>Is page se elements nahi mile.<br>Page load hone ke baad refresh karo, ya koi normal website kholo.</div>`;
          } else {
            const info = mk('div', '', `<div style="color:var(--muted);font-size:11px;margin-bottom:8px">${t.elements.length} interactive elements — agent <code>click {ref}</code> / <code>type {ref,text}</code> use karta hai</div>`);
            body.appendChild(info);
            t.elements.forEach(e => {
              const row = mk('div', 'el');
              row.dataset.ref = e.ref;
              row.innerHTML = `<div><span class="k">#${e.ref} ${esc(e.kind)}</span>${esc((e.text || '').slice(0, 90))}</div>${e.href ? `<div class="u">${esc(e.href.slice(0, 90))}</div>` : ''}`;
              row.onclick = () => { pageCmd(t, 'select', { ref: e.ref }); };
              row.ondblclick = () => { pageCmd(t, 'click', { ref: e.ref }); };
              body.appendChild(row);
            });
          }
        } else if (panelMode === 'text') {
          const pre = mk('div', 'reader-text', esc(t.text || '(no text captured yet)'));
          body.appendChild(pre);
        } else {
          body.innerHTML = `
            <div class="kv">
              <b>URL</b><span class="mono" style="word-break:break-all">${esc(t.url)}</span>
              <b>Title</b><span>${esc(t.title)}</span>
              <b>Elements</b><span>${t.elements.length}</span>
              <b>Text chars</b><span>${t.text.length}</span>
              <b>Last snapshot</b><span>${t.lastSnapshot ? new Date(t.lastSnapshot).toLocaleTimeString() : '—'}</span>
              <b>History</b><span>${t.hi + 1}/${t.history.length}</span>
            </div>
            <div style="margin-top:12px;display:flex;gap:6px;flex-wrap:wrap">
              <button class="tb-btn" data-t="snap">🔄 snapshot</button>
              <button class="tb-btn" data-t="scroll">↓ scroll</button>
              <button class="tb-btn" data-t="reader">📖 server text</button>
            </div>
            <div id="toolsOut" class="mono" style="margin-top:10px;font-size:11px;color:var(--muted);white-space:pre-wrap"></div>`;
          body.querySelectorAll('[data-t]').forEach(b => {
            b.onclick = async () => {
              const out = body.querySelector('#toolsOut');
              const act = b.dataset.t;
              if (act === 'snap') { await pageCmd(t, 'snapshot', {}); out.textContent = 'snapshot requested'; }
              if (act === 'scroll') { const r = await pageCmd(t, 'scroll', { y: 700 }); out.textContent = JSON.stringify(r); }
              if (act === 'reader') {
                out.textContent = 'fetching…';
                try {
                  const r = await WebOS.api.readUrl(t.url);
                  t.text = r.text || t.text; t.title = r.title || t.title;
                  panelMode = 'text'; renderPanel(); publish();
                } catch (e) { out.textContent = 'failed: ' + e.message; }
              }
            };
          });
        }
        panel.appendChild(body);
      }

      /* ---- toolbar wiring ---- */
      toolbar.addEventListener('click', (e) => {
        const act = e.target.dataset && e.target.dataset.act;
        if (!act) return;
        const t = activeTab();
        if (act === 'back') goBack(t);
        if (act === 'fwd') goForward(t);
        if (act === 'reload') navigate(t, t.url, { skipHistory: true });
        if (act === 'home') navigate(t, 'webos://start', { skipHistory: false });
        if (act === 'go') submitOmni();
        if (act === 'panel') togglePanel();
        if (act === 'chromium') {
          // asli headless Chromium app (server mode) — isi URL ke saath kholo
          const u = t && t.url && !/^webos:/.test(t.url) ? t.url : '';
          try {
            WebOS.open('chromium');
            if (WebOS.isLocal) {
              WebOS.notify('Chromium', 'Single-file build me pehle remote server URL daalo (🌐 window me)');
            } else if (u) {
              // asli Chromium me wahi URL kholo (bus op; GUI ke bina bhi chalta hai)
              setTimeout(() => {
                WebOS.handleCommand({ op: 'chrome.goto', app: 'chromium', args: { url: u } })
                  .catch(() => {});
              }, 400);
              WebOS.notify('Chromium', 'Asli Chromium me khul raha hai: ' + u.slice(0, 60));
            }
          } catch (e) {}
        }
      });
      function submitOmni() {
        const v = omni.value.trim();
        if (!v) return;
        const url = looksLikeUrl(v) ? normalizeUrl(v) : ('webos://search?q=' + encodeURIComponent(v));
        navigate(activeTab(), url);
      }
      omni.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitOmni(); });
      omni.addEventListener('focus', () => omni.select());

      root.addEventListener('keydown', (e) => {
        if (e.ctrlKey && e.key.toLowerCase() === 'k') { e.preventDefault(); omni.focus(); }
        if (e.ctrlKey && e.key.toLowerCase() === 't') { e.preventDefault(); createTab('webos://start'); }
        if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); goBack(); }
        if (e.key === 'F5') { e.preventDefault(); const t = activeTab(); navigate(t, t.url, { skipHistory: true }); }
      });

      /* ---- state for the agent ---- */
      function publish() {
        const t = activeTab();
        a.publishState({
          searchResults: t && t.searchResults ? t.searchResults.slice(0, 10) : [],
          url: t ? t.url : null,
          title: t ? t.title : null,
          loading: t ? t.loading : false,
          tabs: tabs.map(x => ({ id: x.id, url: x.url, title: x.title, active: x.id === activeId })),
          elements: t ? t.elements.slice(0, 60) : [],
          elementCount: t ? t.elements.length : 0,
          textPreview: t ? (t.text || '').slice(0, 4000) : '',
          panel: panelMode
        });
      }

      /* ---- agent command handler ---- */
      async function handleCommand(cmd) {
        const args = cmd.args || {};
        const op = String(cmd.op || '').toLowerCase();
        const t = activeTab();

        switch (op) {
          case 'navigate': case 'goto': case 'open-url':
          case 'browse': {
            const url = args.url || args.href || cmd.url;
            if (!url) return { ok: false, error: 'args.url required' };
            if (args.newTab || args.newWindow) { const nt = createTab(url); return { ok: true, tab: nt.id, url }; }
            const target = tabs.find(x => x.id === args.tab) || t;
            const res = await navigate(target, url, { timeout: args.timeout || 20000 });
            return {
              ok: res !== false, url: target.url, title: target.title,
              elements: target.elements.length, textPreview: (target.text || '').slice(0, 1500)
            };
          }
          case 'search': {
            const q = args.q || args.query || args.text;
            if (!q) return { ok: false, error: 'args.q required' };
            const r = await doSearch(t, q);
            return {
              ok: true, url: t.url, count: r.results, engine: r.engine, query: q,
              results: (t.searchResults || []).slice(0, Number(args.limit) || 15).map(x => ({ title: x.title, url: x.url, snippet: (x.snippet || '').slice(0, 200) }))
            };
          }
          case 'back': return { ok: goBack(t), url: t ? t.url : null };
          case 'forward': case 'fwd': return { ok: goForward(t), url: t ? t.url : null };
          case 'reload': case 'refresh': await navigate(t, t.url, { skipHistory: true }); return { ok: true, url: t.url };
          case 'home': await navigate(t, 'webos://start'); return { ok: true, url: 'webos://start' };
          case 'read': case 'snapshot': {
            if (localMode() && t && t.elements.length === 0) {
              return {
                ok: false, localMode: true, url: t.url,
                error: 'local (single-file) build me page ke andar inject nahi ho sakta — ' +
                       'elements/text ke liye server mode chalao: node server.js'
              };
            }
            const mode = args.mode || 'auto';
            let text = t ? t.text : '';
            let title = t ? t.title : '';
            let url = t ? t.url : '';
            let elements = t ? t.elements : [];
            if ((mode === 'server' || !text || text.length < 60) && url && !/^webos:/.test(url)) {
              try {
                const r = await WebOS.api.readUrl(url);
                if (r && !r.error) { text = r.text || text; title = r.title || title; }
              } catch (e) {}
            }
            if (mode === 'elements') return { ok: true, url, title, elements: elements.slice(0, Number(args.limit) || 100) };
            if (mode === 'text') return { ok: true, url, title, text: (text || '').slice(0, Number(args.limit) || 20000) };
            return {
              ok: true, url, title,
              text: (text || '').slice(0, Number(args.limit) || 12000),
              elements: elements.slice(0, Number(args.limit) || 100)
            };
          }
          case 'links': {
            return { ok: true, links: (t ? t.elements : []).filter(e => e.kind === 'link').map(e => ({ ref: e.ref, text: e.text, href: e.href })) };
          }
          case 'inputs': {
            return {
              ok: true,
              inputs: (t ? t.elements : []).filter(e => e.kind === 'input').map(e => ({ ref: e.ref, tag: e.tag, name: e.name, type: e.type, text: e.text })),
              buttons: (t ? t.elements : []).filter(e => e.kind !== 'input').slice(0, 25).map(e => ({ ref: e.ref, text: e.text, href: e.href }))
            };
          }
          case 'click': {
            if (!t) return { ok: false, error: 'no tab' };
            let ref = args.ref;
            if (!ref && (args.text || args.selector)) {
              const needle = String(args.text || args.selector).toLowerCase().trim();
              const pool = t.elements.filter(e => e.kind !== 'input');
              const exact = pool.find(e => (e.text || '').toLowerCase().trim() === needle);
              const starts = pool.find(e => (e.text || '').toLowerCase().trim().startsWith(needle));
              const has = pool.find(e => (e.text || '').toLowerCase().includes(needle));
              const inp = t.elements.find(e => e.kind === 'input' && (e.text || '').toLowerCase().includes(needle));
              const picked = exact || starts || has || inp;
              ref = picked && picked.ref;
              if (!ref) return { ok: false, error: 'no element matching: ' + needle, elements: t.elements.slice(0, 40) };
              if (!args.expect && picked.href) { /* let it navigate normally */ }
            }
            if (!ref) return { ok: false, error: 'args.ref or args.text required' };
            const r = await pageCmd(t, 'click', { ref: Number(ref) });
            if (args.wait !== false) await new Promise(res => setTimeout(res, args.settle || 900));
            return { ok: r.ok !== false, clicked: Number(ref), url: t.url, title: t.title, error: r.error, elements: t.elements.length };
          }
          case 'type': case 'fill': {
            if (!t) return { ok: false, error: 'no tab' };
            let ref = args.ref;
            if (!ref && args.selector) {
              const f = t.elements.find(e => e.kind === 'input' && (e.text || '').toLowerCase().includes(String(args.selector).toLowerCase()));
              ref = f && f.ref;
            }
            const BAD_TYPES = ['submit', 'button', 'reset', 'image', 'checkbox', 'radio', 'file', 'hidden'];
            const textInputs = () => t.elements.filter(e =>
              e.kind === 'input' && !BAD_TYPES.includes(String(e.type || '').toLowerCase()) && e.tag !== 'select' && e.tag !== 'button');
            if (!ref && args.field != null && textInputs().length) {
              const list = textInputs();
              const idx = Number(args.field) || 0;
              ref = list[idx] && list[idx].ref;
            }
            if (!ref && (args.field != null)) {
              const list = textInputs();
              if (!ref) return { ok: false, error: 'no text input at field ' + args.field, inputs: list.map(e => ({ ref: e.ref, name: e.name, type: e.type })) };
            }
            if (!ref) return { ok: false, error: 'args.ref / args.field required', inputs: t.elements.filter(e => e.kind === 'input') };
            const text = String(args.text != null ? args.text : args.value != null ? args.value : '');
            const r = await pageCmd(t, 'type', { ref: Number(ref), text, submit: !!args.submit });
            if (args.submit || args.wait) await new Promise(res => setTimeout(res, args.settle || 1600));
            publish();
            return { ok: r.ok !== false, ref: Number(ref), typed: text, url: t.url, error: r.error };
          }
          case 'press': case 'key': {
            if (!t) return { ok: false, error: 'no tab' };
            const r = await pageCmd(t, 'key', { key: args.key || 'Enter' });
            return { ok: r.ok !== false, error: r.error };
          }
          case 'scroll': {
            if (!t) return { ok: false, error: 'no tab' };
            const r = await pageCmd(t, args.y === 'bottom' ? 'scrollTo' : 'scroll', { y: args.y === 'bottom' ? 999999 : Number(args.y) || 700 });
            return { ok: r.ok !== false, error: r.error };
          }
          case 'eval': {
            if (!t) return { ok: false, error: 'no tab' };
            if (!args.code) return { ok: false, error: 'args.code required' };
            const r = await pageCmd(t, 'eval', { code: args.code });
            return { ok: r.ok !== false, value: r.value, error: r.error };
          }
          case 'tabs': return { ok: true, tabs: tabs.map(x => ({ id: x.id, url: x.url, title: x.title, active: x.id === activeId })) };
          case 'newtab': { const nt = createTab(args.url || 'webos://start'); return { ok: true, tab: nt.id }; }
          case 'closetab': {
            if (args.id) { closeTab(args.id); return { ok: true }; }
            if (t) { closeTab(t.id); return { ok: true }; }
            return { ok: false, error: 'no tab' };
          }
          case 'switchtab': {
            const target = tabs.find(x => x.id === args.id) || tabs[Number(args.index) || 0];
            if (!target) return { ok: false, error: 'tab not found', tabs: tabs.map(x => x.id) };
            setActive(target.id);
            return { ok: true, tab: target.id, url: target.url };
          }
          case 'panel': {
            if (args.mode === 'off') { panelMode = null; panel.classList.add('hide'); }
            else togglePanel(args.mode || 'elements');
            return { ok: true, panel: panelMode };
          }
          case 'extract': {
            // server-side text extraction of any url, works without executing the page
            const url = args.url || (t && t.url);
            if (!url) return { ok: false, error: 'no url' };
            try {
              const r = await WebOS.api.readUrl(url);
              return { ok: true, url: r.url || url, title: r.title, text: (r.text || '').slice(0, Number(args.limit) || 12000), linkCount: (r.links || []).length, links: (r.links || []).slice(0, 60) };
            } catch (e) { return { ok: false, error: e.message }; }
          }
          default:
            return null; // not a browser op -> let other handlers try
        }
      }

      /* ---- init ---- */
      const startUrl = (a.args && (a.args.url || a.args.arg)) || 'webos://start';
      createTab(startUrl);
      a.setTitle('Browser', hostOf(startUrl));
      const origPublish = publish;
      publish = function () { origPublish(); const t = activeTab(); a.setSubtitle(t ? hostOf(t.url) : ''); };

      return {
        handleCommand,
        onArgs(nargs) { if (nargs && nargs.url) navigate(activeTab(), nargs.url); else if (nargs && nargs.arg) navigate(activeTab(), nargs.arg); },
        state() {
          const t = activeTab();
          return {
            url: t ? t.url : null, title: t ? t.title : null, loading: t ? t.loading : false,
            tabs: tabs.map(x => ({ id: x.id, url: x.url, title: x.title, active: x.id === activeId })),
            elements: t ? t.elements.slice(0, 80) : [],
            elementCount: t ? t.elements.length : 0,
            textPreview: t ? (t.text || '').slice(0, 4000) : '',
            panel: panelMode
          };
        },
        destroy() {
          tabs.forEach(t => { try { t.wrap.remove(); } catch (e) {} });
          tabs = [];
        }
      };
    }
  });
})();
