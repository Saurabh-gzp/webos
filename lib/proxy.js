'use strict';
/**
 * Web proxy for the in-OS browser.
 *  - fetchHTML(url)  : fetch + rewrite so it can be shown inside an iframe
 *  - fetchRaw(url)   : pass-through for images / css / fonts
 *  - extractText(url): reader mode (agent friendly)
 *  - search(q)       : DuckDuckGo lite search -> structured results
 */
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 WebOS/1.0';

function absolutize(u, base) {
  try { return new URL(u, base).toString(); } catch { return u; }
}

function encode(u) { return encodeURIComponent(u); }

/** Rewrite an absolute URL so it is fetched through our proxy (same-origin for the iframe). */
function proxied(u) {
  if (!u) return u;
  const s = String(u).trim();
  if (/^(data:|blob:|about:|javascript:|mailto:|tel:|#)/i.test(s)) return s;
  return '/api/proxy/raw?url=' + encode(s);
}

function rewriteCssUrls(css, baseUrl) {
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, q, u) => {
    const abs = absolutize(u, baseUrl);
    // point straight at the passthrough endpoint: nested proxying breaks fonts/img
    return 'url("' + '/api/proxy/raw?url=' + encodeURIComponent(abs) + '")';
  });
}

/** decode common HTML entities so agent-facing text is clean */
function decodeEntities(s) {
  return String(s == null ? '' : s)
    .replace(/&#x27;|&#39;|&apos;/gi, "'")
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&mdash;/gi, '—')
    .replace(/&ndash;/gi, '–')
    .replace(/&hellip;/gi, '…')
    .replace(/&#(\d+);/g, (m, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/gi, '&');
}

/** Rewrite resource-bearing attributes inside the HTML so nothing has to reach the internet directly. */
function rewriteResources(html, baseUrl) {
  // src / href / poster / srcset on resource tags
  html = html.replace(/<(img|script|link|source|video|audio|iframe|embed|track|input)\b[^>]*>/gi, (tag) => {
    return tag
      .replace(/\b(src|href|poster|data)\s*=\s*(["'])(.*?)\2/gi, (m, attr, q, val) => {
        if (!val || /^(data:|blob:|about:|javascript:|#|mailto:|tel:)/i.test(val.trim())) return m;
        if (attr.toLowerCase() === 'href' && /rel\s*=\s*["']?(alternate|canonical|amphtml)/i.test(tag)) return m;
        return attr + '=' + q + proxied(absolutize(val, baseUrl)) + q;
      })
      .replace(/\bsrcset\s*=\s*(["'])(.*?)\1/gi, (m, q, val) => {
        const out = val.split(',').map(part => {
          const bits = part.trim().split(/\s+/);
          if (!bits[0]) return part;
          bits[0] = proxied(absolutize(bits[0], baseUrl));
          return bits.join(' ');
        }).join(', ');
        return 'srcset=' + q + out + q;
      });
  });

  // inline <style> blocks
  html = html.replace(/(<style[^>]*>)([\s\S]*?)(<\/style>)/gi, (m, a, css, b) => a + rewriteCssUrls(css, baseUrl) + b);
  // style="" attributes
  html = html.replace(/\bstyle\s*=\s*(["'])(.*?)\1/gi, (m, q, css) => 'style=' + q + rewriteCssUrls(css, baseUrl) + q);

  return html;
}

/* Injected before any site script runs: the page lives in a sandboxed iframe
   (opaque origin), so cookie/storage access would throw SecurityError and break
   modern sites. Give them harmless in-memory shims instead. */
const PRE_SHIM = `<script data-webos-preshim>(function(){
  try {
    Object.defineProperty(document, 'cookie', {
      get: function(){ return window.__webosCookie || ''; },
      set: function(v){ window.__webosCookie = String(v); },
      configurable: true
    });
  } catch(e){}
  function makeStore(){
    var m = {};
    return {
      getItem: function(k){ return Object.prototype.hasOwnProperty.call(m, String(k)) ? m[String(k)] : null; },
      setItem: function(k, v){ m[String(k)] = String(v); },
      removeItem: function(k){ delete m[String(k)]; },
      clear: function(){ m = {}; },
      key: function(i){ return Object.keys(m)[i] || null; },
      get length(){ return Object.keys(m).length; }
    };
  }
  try { Object.defineProperty(window, 'localStorage', { get: function(){ return window.__webosLS || (window.__webosLS = makeStore()); }, configurable: true }); } catch(e){}
  try { Object.defineProperty(window, 'sessionStorage', { get: function(){ return window.__webosSS || (window.__webosSS = makeStore()); }, configurable: true }); } catch(e){}
  try { if (typeof document.hasStorageAccess !== 'function') document.hasStorageAccess = function(){ return Promise.resolve(true); }; } catch(e){}
  try { if (typeof document.requestStorageAccess !== 'function') document.requestStorageAccess = function(){ return Promise.resolve(); }; } catch(e){}
  try { window.matchMedia = window.matchMedia || function(q){ return { matches:false, media:q, addListener:function(){}, removeListener:function(){}, addEventListener:function(){}, removeEventListener:function(){} }; }; } catch(e){}
})();</script>`;

const BRIDGE = `
<script data-webos-bridge>(function(){
  if (window.__webosBridge) return; window.__webosBridge = true;
  var P = window.parent;
  var refMap = new WeakMap(); var nextRef = 1;   // stable refs across snapshots
  function unwrap(u){
    if (!u) return u;
    var i = String(u).indexOf('/api/proxy?url=');
    if (i >= 0) { try { return decodeURIComponent(String(u).slice(i + 15).split('&')[0]); } catch(e){ return u; } }
    return u;
  }
  function abs(u){ try { return new URL(u || '', document.baseURI).href; } catch(e){ return u; } }
  function realBase(){ try { return unwrap(document.baseURI) || location.href; } catch(e){ return location.href; } }
  function realHref(){ return unwrap(location.href); }
  function q(sel, root){ try { return (root||document).querySelectorAll(sel); } catch(e){ return []; } }
  function txt(el){ return (el.innerText || el.textContent || '').replace(/\\s+/g,' ').trim(); }
  function visible(el){
    if (!el) return false;
    var s = window.getComputedStyle(el);
    if (s && (s.display === 'none' || s.visibility === 'hidden')) return false;
    var r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    if (r && r.width < 1 && r.height < 1) return false;
    return true;
  }
  function refOf(el){
    var r = refMap.get(el);
    if (!r) { r = nextRef++; refMap.set(el, r); }
    try { el.setAttribute('data-webos-ref', String(r)); } catch(e){}
    return r;
  }
  function elements(){
    var out = [];
    function add(el, kind){
      var r = el.getBoundingClientRect();
      out.push({
        ref: refOf(el), kind: kind, tag: el.tagName.toLowerCase(),
        text: (kind === 'input' ? (el.value || el.placeholder || '') : txt(el)).slice(0,180),
        href: el.href || undefined,
        name: el.name || undefined, type: el.type || undefined,
        rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]
      });
    }
    q('a[href]').forEach(function(a){ if (visible(a) && txt(a)) add(a,'link'); });
    q('button, [role=button], input[type=submit], input[type=button]').forEach(function(b){ if (visible(b)) add(b, 'button'); });
    q('input:not([type=submit]):not([type=button]), textarea, select').forEach(function(i){ if (visible(i)) add(i, i.tagName.toLowerCase(), 'input'); });
    return out.slice(0, 400);
  }
  function snapshot(){
    var body = document.body;
    var text = body ? (body.innerText || body.textContent || '') : '';
    text = text.replace(/\\n{3,}/g,'\\n\\n').trim().slice(0, 60000);
    send({ type:'page', url: realHref(), title: document.title || '', text: text, elements: elements(), ts: Date.now() });
  }
  function send(msg){ try { P.postMessage(Object.assign({ __webos:true }, msg), '*'); } catch(e){} }
  function byRef(ref){ return document.querySelector('[data-webos-ref="' + ref + '"]'); }
  function clickEl(ref){
    var el = byRef(ref);
    if (!el) return false;
    el.scrollIntoView({ block:'center' });
    try { el.focus(); } catch(e){}
    el.click();
    return true;
  }
  function typeEl(ref, value, submit){
    var el = byRef(ref);
    if (!el) return false;
    el.scrollIntoView({ block:'center' });
    try { el.focus(); } catch(e){}
    if (el.tagName === 'SELECT') { el.value = value; }
    else {
      el.value = String(value);
      el.dispatchEvent(new Event('input', { bubbles:true }));
      el.dispatchEvent(new Event('change', { bubbles:true }));
    }
    if (submit) {
      var form = el.form || (el.closest && el.closest('form'));
      if (form) { try { form.requestSubmit ? form.requestSubmit() : form.submit(); } catch(e){ try { form.submit(); } catch(e2){} } }
      else {
        el.dispatchEvent(new KeyboardEvent('keydown', { key:'Enter', keyCode:13, which:13, bubbles:true }));
        el.dispatchEvent(new KeyboardEvent('keypress', { key:'Enter', keyCode:13, which:13, bubbles:true }));
        el.dispatchEvent(new KeyboardEvent('keyup', { key:'Enter', keyCode:13, which:13, bubbles:true }));
      }
    }
    return true;
  }
  // Intercept link clicks so navigation stays inside the OS browser window
  document.addEventListener('click', function(ev){
    var a = ev.target && ev.target.closest ? ev.target.closest('a[href]') : null;
    if (!a) return;
    var href = a.getAttribute('href') || '';
    if (!href || href.charAt(0) === '#') return;
    ev.preventDefault();
    ev.stopPropagation();
    send({ type:'navigate', url: abs(href), newTab: a.target === '_blank', ts: Date.now() });
  }, true);
  // window.open -> open as a new OS tab instead of a raw popup
  try {
    window.open = function(u){ send({ type:'navigate', url: abs(u || location.href), newTab:true }); return null; };
  } catch(e){}
  document.addEventListener('submit', function(ev){
    var f = ev.target;
    if (!f || f.tagName !== 'FORM') return;
    ev.preventDefault();
    var method = (f.method || 'GET').toUpperCase();
    var data = new URLSearchParams(new FormData(f)).toString();
    var orig = f.getAttribute('data-webos-action');
    var action;
    if (orig) action = abs(orig);
    else if (f.getAttribute('action')) action = unwrap(abs(f.getAttribute('action')));
    else action = realBase();
    if (method === 'GET') action += (action.indexOf('?') >= 0 ? '&' : '?') + data;
    send({ type:'form', url: action, method: method, data: data, ts: Date.now() });
  }, true);
  // requests from parent OS shell
  window.addEventListener('message', function(ev){
    var d = ev.data || {};
    if (!d.__webosCmd) return;
    var res = { ok:false };
    try {
      if (d.op === 'snapshot') { snapshot(); return; }
      if (d.op === 'click') res.ok = clickEl(d.ref);
      else if (d.op === 'type') res.ok = typeEl(d.ref, d.text, d.submit);
      else if (d.op === 'scroll') { window.scrollBy(0, d.y||600); res.ok = true; }
      else if (d.op === 'scrollTo') { window.scrollTo(0, d.y||0); res.ok = true; }
      else if (d.op === 'eval') { res.value = String(eval(d.code)); res.ok = true; }
      else if (d.op === 'select') {
        var el = byRef(d.ref);
        if (el && el.scrollIntoView) { el.scrollIntoView({ block:'center' }); el.style.outline = '3px solid #ff9d00'; setTimeout(function(){ el.style.outline=''; }, 1200); res.ok = true; }
      }
    } catch(e) { res.error = String(e && e.message || e); }
    if (d.replyId) send({ type:'cmdResult', replyId: d.replyId, result: res });
  });
  if (document.readyState === 'complete' || document.readyState === 'interactive') setTimeout(snapshot, 60);
  else document.addEventListener('DOMContentLoaded', function(){ setTimeout(snapshot, 60); });
  window.addEventListener('load', function(){ setTimeout(snapshot, 220); });
  setTimeout(snapshot, 900);
  setInterval(function(){ snapshot(); }, 3000);
  window.addEventListener('keydown', function(){ setTimeout(snapshot, 120); }, true);
})();</script>`;

function rewriteHtml(html, pageUrl) {
  const u = new URL(pageUrl);
  const dirBase = pageUrl.replace(/[#?].*$/, '');

  // Remove frame busting / CSP meta tags
  html = html
    .replace(/<meta[^>]+http-equiv\s*=\s*["']?(content-security-policy|x-frame-options)["']?[^>]*>/gi, '')
    .replace(/<meta[^>]+http-equiv\s*=\s*["']?refresh["']?[^>]*>/gi, m => {
      const mm = /url\s*=\s*['"]?([^'";]+)/i.exec(m);
      if (!mm) return '';
      const target = absolutize(mm[1], dirBase);
      return '<meta http-equiv="refresh" content="0;url=' + '/api/proxy?url=' + encode(target) + '">';
    });

  // Neutralise inline frame-busting scripts (top/location tricks)
  html = html.replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gi, (m, code) => {
    if (/top\s*(!==|!=|===|==)|self\s*!==\s*top|top\.location|parent\.location/i.test(code) && code.length < 4000) {
      return '<script data-webos-stripped="1">/* frame-busting script removed by WebOS */</script>';
    }
    return m;
  });

  html = rewriteResources(html, dirBase);

  // Anchor: keep original href but let our injected click handler intercept it.
  // Forms: point to our proxy (bridge also intercepts submit).
  html = html.replace(/<form\b[^>]*>/gi, (tag) => {
    const m = /\baction\s*=\s*(["']?)(.*?)\1(?=[\s>])/i.exec(tag);
    const original = m ? m[2] : '';
    const realAction = original ? absolutize(original, dirBase) : pageUrl;
    let out = tag
      .replace(/\baction\s*=\s*(["']?)(.*?)\1(?=[\s>])/gi, (mm, q, val) => 'action="' + '/api/proxy?url=' + encode(absolutize(val, dirBase)) + '"')
      .replace(/\btarget\s*=\s*(["']?)(.*?)\1(?=[\s>])/gi, '');
    // remember the ORIGINAL action so the injected bridge can submit correctly
    out = out.replace(/^<form/i, '<form data-webos-action="' + String(original).replace(/"/g, '&quot;') + '" data-webos-real="' + realAction.replace(/"/g, '&quot;') + '"') ;
    return out;
  });

  const base = '<base href="' + dirBase + '">' +
    '<style data-webos-base>:root{color-scheme:light}html{background:#ffffff}</style>';
  const head = '<head' + (/<head[^>]*>/i.test(html) ? '>' : '>');
  const preShim = PRE_SHIM.replace('<script', '<script');
  if (/<head[^>]*>/i.test(html)) {
    html = html.replace(/<head[^>]*>/i, (m) => m + base + preShim + '<meta name="referrer" content="no-referrer">');
  } else {
    html = base + preShim + html;
  }

  // Inject bridge at the very end so it runs last
  if (/<\/body>/i.test(html)) html = html.replace(/<\/body>/i, BRIDGE + '</body>');
  else html += BRIDGE;

  return html;
}

async function fetchWithTimeout(url, opts = {}, ms = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, {
      redirect: 'follow',
      ...opts,
      signal: ctrl.signal,
      headers: {
        'user-agent': UA,
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9,hi;q=0.8',
        ...(opts.headers || {})
      }
    });
  } finally { clearTimeout(t); }
}

async function fetchHTML(rawUrl, opts = {}) {
  let url = rawUrl;
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url.replace(/^\/+/, '');
  const reqOpts = { method: opts.method && opts.method !== 'GET' ? 'POST' : 'GET', headers: {} };
  if (reqOpts.method === 'POST') {
    reqOpts.body = opts.body || '';
    reqOpts.headers['content-type'] = opts.contentType || 'application/x-www-form-urlencoded';
  }
  const res = await fetchWithTimeout(url, reqOpts);
  const ct = res.headers.get('content-type') || '';
  const finalUrl = res.url || url;
  if (!/text\/html|text\/plain|application\/xhtml/i.test(ct) && ct) {
    return { kind: 'binary', contentType: ct, finalUrl, status: res.status };
  }
  let html = await res.text();
  // strip integrity attributes (broken once resources are rewritten) and charset weirdness
  html = html.replace(/\sintegrity\s*=\s*(["']).*?\1/gi, '');
  const pages = {
    url: finalUrl,
    status: res.status,
    contentType: ct,
    html: rewriteHtml(html, finalUrl)
  };
  return pages;
}

async function fetchRaw(url, referer) {
  const res = await fetchWithTimeout(url, { headers: referer ? { referer } : {} }, 25000);
  const ct = (res.headers.get('content-type') || 'application/octet-stream').toString();
  const buf = Buffer.from(await res.arrayBuffer());
  if (/text\/css/i.test(ct)) {
    const css = buf.toString('utf8');
    return { contentType: ct, body: Buffer.from(rewriteCssUrls(css, res.url || url), 'utf8') };
  }
  return { contentType: ct, body: buf, status: res.status, finalUrl: res.url };
}

/** Strip a fetched page down to readable text + links (no execution needed) */
async function extractText(rawUrl) {
  const r = await fetchHTML(rawUrl);
  if (r.kind === 'binary') return { url: r.finalUrl, title: '', text: '[non-html content: ' + r.contentType + ']', links: [] };
  let html = r.html;
  const title = (/(<title[^>]*>)([\s\S]*?)<\/title>/i.exec(html) || [])[2] || '';
  const links = [];
  const linkRe = /<a\b[^>]*href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = linkRe.exec(html)) && links.length < 250) {
    const href = absolutize(m[2], r.url);
    if (/^(javascript:|#|mailto:|tel:)/i.test(href)) continue;
    const text = decodeEntities(m[3].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
    if (!text) continue;
    links.push({ text: text.slice(0, 160), href });
  }
  html = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|section|article|h[1-6]|li|tr|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  const text = decodeEntities(html)
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .split('\n').map(s => s.trim()).join('\n').trim();
  return { url: r.url, title: title.replace(/\s+/g, ' ').trim(), text: text.slice(0, 80000), links, status: r.status };
}

/* ---------------- web search ----------------

   Datacenter IPs (Render/Vercel/Fly) are treated very differently from
   residential ones by the big engines: DuckDuckGo bot-walls them and Bing
   sometimes answers with a regional/trending feed instead of the query.
   So the stack is ordered by "actually works from a cloud IP", and every
   engine's output has to pass a relevance check before we trust it:

     1. searx (public SearXNG instances) - respects the query, no bot wall
     2. bing html                        - good when it answers honestly
     3. bing rss
     4. brave html                       - rate-limits (429) from some IPs
     5. wikipedia api                    - guaranteed last resort (factual)

   DuckDuckGo is kept as an extra engine but is tried last: it works from
   residential IPs and returns a challenge page from cloud ones.            */

const SEARX_INSTANCES = [
  'https://searxng.site',
  'https://opnxng.com'
];

const SEARCH_STOPWORDS = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'are', 'was', 'how', 'what',
  'when', 'where', 'which', 'best', 'top', 'new', 'you', 'your', 'can', 'not', 'but', 'all', 'any', 'get', 'use']);

function queryTokens(query) {
  return String(query || '').toLowerCase().split(/[^a-z0-9]+/)
    .filter(t => t.length >= 3 && !SEARCH_STOPWORDS.has(t))
    .slice(0, 8);
}

function cleanText(x) {
  return decodeEntities(String(x == null ? '' : x).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
}

/**
 * Reject results that do not actually answer the query.
 * Needs a hit on the first result plus at least two distinct query tokens
 * across the top results (or every token when the query is short).
 */
function isRelevant(query, results) {
  const tokens = queryTokens(query);
  if (!tokens.length || !results || !results.length) return true;
  const top = results.slice(0, 8);
  const hay = top.map(r => ((r.title || '') + ' ' + (r.url || '') + ' ' + (r.snippet || '')).toLowerCase()).join(' ');
  const matched = tokens.filter(t => hay.includes(t));
  const firstHay = ((top[0].title || '') + ' ' + (top[0].url || '') + ' ' + (top[0].snippet || '')).toLowerCase();
  const firstMatches = tokens.some(t => firstHay.includes(t));
  const needed = tokens.length === 1 ? 1 : 2;
  return firstMatches && matched.length >= needed;
}

function searxInstanceName(base) {
  try { return new URL(base).host.replace(/^www\./, ''); } catch (e) { return base; }
}

async function searxHtml(query) {
  const errors = [];
  for (const base of SEARX_INSTANCES) {
    const url = base + '/search?q=' + encodeURIComponent(query);
    try {
      const res = await fetchWithTimeout(url, {
        headers: { accept: 'text/html', 'accept-language': 'en-US,en;q=0.9' }
      }, 18000);
      if (res.status !== 200) { errors.push(searxInstanceName(base) + ': http ' + res.status); continue; }
      const html = await res.text();
      const blocks = html.split(/<article class="result[^"]*"/).slice(1);
      const results = [];
      for (const b of blocks) {
        if (results.length >= 25) break;
        const h3 = /<h3>\s*<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(b);
        if (!h3) continue;
        const content = /<p class="content[^"]*">([\s\S]*?)<\/p>/i.exec(b);
        const link = decodeEntities(h3[1]);
        if (!/^https?:/i.test(link)) continue;
        results.push({
          title: cleanText(h3[2]),
          url: link,
          snippet: content ? cleanText(content[1]) : ''
        });
      }
      if (results.length) return { engine: 'searx:' + searxInstanceName(base), url, results };
      errors.push(searxInstanceName(base) + ': no results');
    } catch (e) {
      errors.push(searxInstanceName(base) + ': ' + e.message);
    }
  }
  return { engine: 'searx', url: '', results: [], errors };
}

async function bingHtml(query) {
  const url = 'https://www.bing.com/search?q=' + encodeURIComponent(query) + '&mkt=en-US&setlang=en-US&cc=US';
  const res = await fetchWithTimeout(url, {
    headers: { accept: 'text/html', 'accept-language': 'en-US,en;q=0.9' }
  });
  if (res.status !== 200) return { engine: 'bing', url, results: [], error: 'http ' + res.status };
  const html = await res.text();
  const results = [];
  const blocks = html.split(/<li class="b_algo"/i).slice(1);
  for (const block of blocks) {
    if (results.length >= 25) break;
    // Bing puts the anchor either around or inside the <h2>; prefer that one,
    // otherwise take the longest anchor text that is not a URL/breadcrumb.
    const anchors = [...block.matchAll(/<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)]
      .map(a => ({ href: decodeEntities(a[1]), text: cleanText(a[2]), raw: a[0] }));
    if (!anchors.length) continue;
    const scored = anchors.map(a => {
      let score = a.text.length;
      if (/<h2[^>]*>[\s\S]*?<\/h2>/i.test(a.raw)) score += 200;          // anchor wraps the h2
      if (/https?:\/\/|\s›\s|\bwww\./i.test(a.text)) score -= 300;      // url / breadcrumb text
      return { ...a, score };
    }).sort((x, y) => y.score - x.score);
    const best = scored[0];
    if (!best || !best.text || best.score < 0) continue;
    if (/bing\.com\/rewards|microsoft\.com\/rewards/i.test(best.href)) continue;
    const snip = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(block);
    results.push({ title: best.text, url: best.href, snippet: snip ? cleanText(snip[1]) : '' });
  }
  return { engine: 'bing', url, results };
}

async function bingRss(query) {
  const url = 'https://www.bing.com/search?q=' + encodeURIComponent(query) + '&format=rss&count=20&mkt=en-US&setlang=en-US';
  const res = await fetchWithTimeout(url, {
    headers: { accept: 'application/rss+xml,text/xml', 'accept-language': 'en-US,en;q=0.9' }
  });
  const xml = await res.text();
  const results = [];
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)];
  for (const it of items) {
    if (results.length >= 25) break;
    const t = /<title>([\s\S]*?)<\/title>/i.exec(it[1]);
    const l = /<link>([\s\S]*?)<\/link>/i.exec(it[1]);
    const d = /<description>([\s\S]*?)<\/description>/i.exec(it[1]);
    if (!t || !l) continue;
    results.push({
      title: decodeEntities(t[1].replace(/<!\[CDATA\[|\]\]>/g, '')).trim(),
      url: decodeEntities(l[1]).trim(),
      snippet: d ? decodeEntities(d[1].replace(/<!\[CDATA\[|\]\]>/g, '')).trim() : ''
    });
  }
  return { engine: 'bing-rss', url, results };
}

async function braveHtml(query) {
  const url = 'https://search.brave.com/search?q=' + encodeURIComponent(query) + '&source=web';
  const res = await fetchWithTimeout(url, {
    headers: { accept: 'text/html', 'accept-language': 'en-US,en;q=0.9' }
  });
  if (res.status === 429) return { engine: 'brave', url, results: [], error: 'rate limited (429)' };
  const html = await res.text();
  const blocks = html.split(/<div class="snippet svelte-[^"]*"[^>]*data-type="web"/).slice(1);
  const results = [];
  for (const b of blocks) {
    if (results.length >= 25) break;
    const link = /<a href="(https?:\/\/[^"]+)"/.exec(b);
    const title = /class="title[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(b);
    const desc = /class="snippet-description[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(b) ||
                 /class="generic-snippet[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(b);
    if (!link || !title) continue;
    results.push({ title: cleanText(title[1]), url: decodeEntities(link[1]), snippet: desc ? cleanText(desc[1]) : '' });
  }
  return { engine: 'brave', url, results };
}

async function ddgHtml(query) {
  const url = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query);
  const res = await fetchWithTimeout(url, { headers: { accept: 'text/html' } });
  const html = await res.text();
  const results = [];
  const re = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) && results.length < 25) {
    let href = decodeEntities(m[1]);
    const uddg = /[?&]uddg=([^&]+)/.exec(href);
    if (uddg) href = decodeURIComponent(uddg[1]);
    const title = cleanText(m[2]);
    if (!href || !title) continue;
    results.push({ title, url: href, snippet: '' });
  }
  const snips = [...html.matchAll(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi)].map(x => cleanText(x[1]));
  snips.forEach((sn, i) => { if (results[i]) results[i].snippet = sn; });
  return { engine: 'duckduckgo', url, results };
}

/** Last resort: Wikipedia search never bot-walls and is always on-topic for factual queries. */
async function wikipediaApi(query) {
  const url = 'https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=' +
    encodeURIComponent(query) + '&format=json&srlimit=10&origin=*';
  const res = await fetchWithTimeout(url, { headers: { accept: 'application/json' } }, 15000);
  const j = await res.json();
  const hits = (j && j.query && j.query.search) || [];
  return {
    engine: 'wikipedia',
    url,
    results: hits.map(h => ({
      title: h.title,
      url: 'https://en.wikipedia.org/wiki/' + encodeURIComponent(String(h.title || '').replace(/ /g, '_')),
      snippet: cleanText(h.snippet)
    }))
  };
}

async function search(query) {
  const engines = [searxHtml, bingHtml, bingRss, braveHtml, ddgHtml, wikipediaApi];
  const errors = [];
  let best = null;
  for (const engine of engines) {
    try {
      const r = await engine(query);
      if (r.errors) errors.push(...r.errors);
      if (r.error) errors.push(r.engine + ': ' + r.error);
      if (!r.results || !r.results.length) {
        if (!r.errors && !r.error) errors.push(engine.name + ': no results');
        continue;
      }
      if (!isRelevant(query, r.results)) {
        errors.push(engine.name + ': results off-topic (filtered)');
        if (!best || r.results.length > best.results.length) best = { ...r, offTopic: true };
        continue;
      }
      return { query, engine: r.engine, url: r.url, count: r.results.length, results: r.results, errors };
    } catch (e) {
      errors.push(engine.name + ': ' + e.message);
    }
  }
  if (best) {
    return { query, engine: best.engine, url: best.url, count: best.results.length, results: best.results, offTopic: true, errors };
  }
  return { query, engine: null, count: 0, results: [], errors };
}

module.exports = { fetchHTML, fetchRaw, extractText, search, rewriteCssUrls, encode };
