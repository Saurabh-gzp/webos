'use strict';
/**
 * chromium.js — real Chromium browser sessions for WebOS.
 * ---------------------------------------------------------
 * Ye iframe-wala browser nahi hai: server pe asli headless Chromium chalta hai
 * (Puppeteer/CDP ke through), aur UI sirf live screencast dekhta hai + input
 * bhejta hai. Isliye:
 *
 *   - har website chalti hai (X-Frame-Options / bot-walls ka iframe problem nahi)
 *   - agent ko asli mouse/keyboard milte hain (trusted events, isTrusted=true)
 *   - agent ko screenshot (vision ke liye) + text + elements (refs) milte hain
 *   - same session user aur agent share karte hain (Manus jaisa "live browser")
 *
 * Sab kuch lazily launch hota hai: pehli session maangne par Chromium start hota
 * hai. Agar server pe Chromium available nahi hai (ya memory kam hai), to
 * available:false return hota hai aur OS baaki sab normal chalata rehta hai.
 */
const { EventEmitter } = require('events');

const MAX_SESSIONS = Number(process.env.WEBOS_CHROMIUM_SESSIONS || 2);
const IDLE_MS = Number(process.env.WEBOS_CHROMIUM_IDLE_MS || 10 * 60 * 1000);
const DEFAULT_VIEWPORT = { width: 1280, height: 800 };
const NAV_TIMEOUT = Number(process.env.WEBOS_CHROMIUM_NAV_TIMEOUT || 45000);

const MOBILE_UA = null; // optional override: process.env.WEBOS_CHROMIUM_UA

/** Chromium flags tuned for small cloud containers (Render free = 512MB). */
function launchArgs(extra) {
  const base = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',       // /dev/shm chhota hota hai containers me
    '--disable-gpu',
    '--no-first-run',
    '--no-zygote',
    '--disable-background-networking',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-features=Translate,BackForwardCache,AcceptCHFrame,MediaRouter,OptimizationHints',
    '--disable-extensions',
    '--disable-component-update',
    '--disable-client-side-phishing-detection',
    '--disable-sync',
    '--metrics-recording-only',
    '--mute-audio',
    '--hide-scrollbars',
    '--window-size=' + DEFAULT_VIEWPORT.width + ',' + DEFAULT_VIEWPORT.height
  ];
  if (process.env.WEBOS_CHROMIUM_SINGLE_PROCESS === '1') base.push('--single-process', '--no-zygote');
  const fromEnv = (process.env.WEBOS_CHROMIUM_ARGS || '').split(' ').map(s => s.trim()).filter(Boolean);
  return base.concat(fromEnv, extra || []);
}

/* ------------------------------------------------------------------ */
/* stable element refs (agent ke click/type ke liye)                   */
/* ------------------------------------------------------------------ */
const ELEMENT_SCRIPT = `
  (function () {
    var w = window;
    if (!w.__webosRef) {
      w.__webosRef = { map: new WeakMap(), next: 1 };
    }
    var st = w.__webosRef;
    function refOf(el) {
      var r = st.map.get(el);
      if (!r) { r = st.next++; st.map.set(el, r); }
      try { el.setAttribute('data-webos-ref', String(r)); } catch (e) {}
      return r;
    }
    function txt(el) { return (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim(); }
    function vis(el) {
      if (!el) return false;
      var s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
      var r = el.getBoundingClientRect();
      return r.width > 1 && r.height > 1;
    }
    function describe(el, kind) {
      var r = el.getBoundingClientRect();
      return {
        ref: refOf(el),
        kind: kind,
        tag: el.tagName.toLowerCase(),
        text: (kind === 'input' ? (el.value || el.placeholder || el.getAttribute('aria-label') || '') : txt(el)).slice(0, 200),
        name: el.name || el.id || undefined,
        type: el.type || undefined,
        href: el.href || undefined,
        rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
        inView: r.top < innerHeight && r.bottom > 0
      };
    }
    var out = [];
    document.querySelectorAll('a[href]').forEach(function (a) { if (vis(a) && txt(a)) out.push(describe(a, 'link')); });
    document.querySelectorAll('button, [role=button], input[type=submit], input[type=button], [role=tab]').forEach(function (b) { if (vis(b)) out.push(describe(b, 'button')); });
    document.querySelectorAll('input:not([type=submit]):not([type=button]), textarea, select, [contenteditable=true]').forEach(function (i) { if (vis(i)) out.push(describe(i, 'input')); });
    return out.slice(0, 400);
  })()
`;

const PAGE_INFO_SCRIPT = `
  (function () {
    var body = document.body;
    return {
      title: document.title || '',
      url: location.href,
      readyState: document.readyState,
      text: (body ? (body.innerText || body.textContent || '') : '').replace(/\\n{3,}/g, '\\n\\n').trim().slice(0, 120000),
      scroll: { x: window.scrollX, y: window.scrollY, height: document.documentElement.scrollHeight, viewport: window.innerHeight },
      forms: Array.from(document.forms).slice(0, 20).map(function (f) { return { action: f.action, method: f.method, fields: f.elements.length }; })
    };
  })()
`;

function cleanUrl(u) {
  if (!u) return u;
  const s = String(u).trim();
  if (/^[a-z]+:\/\//i.test(s) || /^(mailto:|tel:)/i.test(s)) return s;
  if (/^localhost(:\d+)?(\/|$)/i.test(s)) return 'http://' + s;
  if (/^[\w-]+(\.[\w-]+)+(\/|:|$)/.test(s) && !/\s/.test(s)) return 'https://' + s;
  return 'https://duckduckgo.com/?q=' + encodeURIComponent(s);
}

class ChromiumSessions extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(100);
    this.browser = null;
    this.launching = null;
    this.sessions = new Map();
    this.lastError = null;
    this.launchedAt = 0;
    this._sweeper = setInterval(() => this.sweep(), 60 * 1000);
    if (this._sweeper.unref) this._sweeper.unref();
  }

  get mode() { return (process.env.WEBOS_CHROMIUM || 'auto').toLowerCase(); }

  /* ---------------- lifecycle ---------------- */

  async available() {
    if (this.mode === 'off') return { available: false, reason: 'WEBOS_CHROMIUM=off (disabled by env)' };
    if (this.browser && this.browser.connected) return { available: true, version: this.version || null, sessions: this.sessions.size };
    if (this.lastError && this.mode !== 'force') return { available: false, reason: this.lastError };
    return { available: !!(this.browser && this.browser.connected), version: this.version || null, sessions: this.sessions.size, pending: !!this.launching };
  }

  async ensureBrowser() {
    if (this.mode === 'off') throw new Error('Chromium disabled (WEBOS_CHROMIUM=off)');
    if (this.browser && this.browser.connected) return this.browser;
    if (this.launching) return this.launching;
    this.launching = (async () => {
      let puppeteer;
      try {
        puppeteer = require('puppeteer');
      } catch (e) {
        throw new Error('puppeteer installed nahi hai — `npm install puppeteer` chalao (ya redeploy karo)');
      }
      const opts = {
        headless: process.env.WEBOS_CHROMIUM_HEADFUL === '1' ? false : (process.env.WEBOS_CHROMIUM_FULL === '1' ? true : 'shell'),
        args: launchArgs(),
        protocolTimeout: 120000,
        defaultViewport: { ...DEFAULT_VIEWPORT },
        dumpio: process.env.WEBOS_CHROMIUM_DUMPIO === '1'
      };
      if (process.env.PUPPETEER_EXECUTABLE_PATH) opts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
      if (MOBILE_UA) opts.args.push('--user-agent=' + MOBILE_UA);
      const browser = await puppeteer.launch(opts);
      this.browser = browser;
      this.launchedAt = Date.now();
      try { this.version = await browser.version(); } catch (e) { this.version = null; }
      browser.on('disconnected', () => {
        this.browser = null;
        this.sessions.forEach(s => { s.closed = true; s.emit('closed'); });
        this.sessions.clear();
        this.emit('browser-disconnected');
      });
      this.lastError = null;
      return browser;
    })();
    try {
      return await this.launching;
    } catch (e) {
      this.lastError = e.message;
      this.launching = null;
      throw e;
    } finally {
      this.launching = null;
    }
  }

  async createSession(opts = {}) {
    if (this.sessions.size >= MAX_SESSIONS) {
      // sabse purani idle session hata do (chhote containers ke liye)
      const oldest = [...this.sessions.values()].sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (oldest) await this.closeSession(oldest.id);
    }
    const browser = await this.ensureBrowser();
    const viewport = {
      width: Math.min(1920, Math.max(320, Number(opts.width) || DEFAULT_VIEWPORT.width)),
      height: Math.min(1200, Math.max(240, Number(opts.height) || DEFAULT_VIEWPORT.height))
    };
    const id = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    await page.setViewport({ ...viewport, deviceScaleFactor: 1 });
    await page.setUserAgent(process.env.WEBOS_CHROMIUM_UA ||
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    await page.setDefaultTimeout(NAV_TIMEOUT);

    // EventEmitter chahiye: session.on('nav'|'closed') UI/SSE streams use karte hain
    const session = Object.assign(new EventEmitter(), {
      id, page, context, viewport,
      createdAt: Date.now(), lastUsed: Date.now(),
      url: 'about:blank', title: '', lastFrame: null, lastFrameAt: 0, frameMeta: null,
      lastAction: null, actionCount: 0, logs: [], closed: false, broadcast: 0
    });

    // console + page errors -> session log (agent debugging ke liye)
    page.on('console', m => {
      if (session.logs.length > 200) session.logs.shift();
      session.logs.push({ ts: Date.now(), type: m.type(), text: String(m.text()).slice(0, 500) });
    });
    page.on('pageerror', e => {
      if (session.logs.length > 200) session.logs.shift();
      session.logs.push({ ts: Date.now(), type: 'pageerror', text: String(e.message).slice(0, 500) });
    });
    page.on('framenavigated', f => {
      if (f === page.mainFrame()) { session.url = f.url(); session.emit('nav'); }
    });

    this.sessions.set(id, session);
    this.emit('session-created', { id });
    this.startScreencast(session);
    return session;
  }

  getSession(id) {
    const s = this.sessions.get(id);
    if (!s || s.closed) return null;
    s.lastUsed = Date.now();
    return s;
  }

  list() {
    return [...this.sessions.values()].map(s => ({
      id: s.id, url: s.url, title: s.title, viewport: s.viewport,
      createdAt: s.createdAt, lastUsed: s.lastUsed, actions: s.actionCount,
      hasFrame: !!s.lastFrame
    }));
  }

  async closeSession(id) {
    const s = this.sessions.get(id);
    if (!s) return false;
    s.closed = true;
    this.sessions.delete(id);
    try { await s.context.close(); } catch (e) {}
    this.emit('session-closed', { id });
    return true;
  }

  async closeAll() {
    for (const id of [...this.sessions.keys()]) await this.closeSession(id);
    if (this.browser) { try { await this.browser.close(); } catch (e) {} this.browser = null; }
  }

  sweep() {
    const now = Date.now();
    for (const s of this.sessions.values()) {
      if (now - s.lastUsed > IDLE_MS) this.closeSession(s.id).catch(() => {});
    }
    if (!this.sessions.size && this.browser && Date.now() - this.launchedAt > 5 * 60 * 1000) {
      // koi session nahi -> Chromium band karke memory free karo (free tier friendly)
      const browser = this.browser;
      this.browser = null;
      try { browser.close(); } catch (e) {}
    }
  }

  /* ---------------- screencast (live view) ---------------- */

  async startScreencast(session) {
    try {
      const client = await session.page.target().createCDPSession();
      session.cdp = client;
      client.on('Page.screencastFrame', async (ev) => {
        session.lastFrame = ev.data;
        session.lastFrameAt = Date.now();
        session.frameMeta = ev.metadata || null;
        try { await client.send('Page.screencastFrameAck', { sessionId: ev.sessionId }); } catch (e) {}
        this.emit('frame', session);
      });
      await client.send('Page.startScreencast', {
        format: 'jpeg',
        quality: Number(process.env.WEBOS_CHROMIUM_QUALITY || 55),
        maxWidth: 1280,
        maxHeight: 800,
        everyNthFrame: 1
      });
    } catch (e) {
      session.screencastError = e.message;
    }
  }

  async refreshFrame(session) {
    // screencast band ho gaya ho (page navigate) to dobara try karo
    if (!session.lastFrame || Date.now() - session.lastFrameAt > 4000) {
      if (!session.cdp) await this.startScreencast(session);
      else {
        try { await session.cdp.send('Page.startScreencast', { format: 'jpeg', quality: 55, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 }); } catch (e) {}
      }
    }
    return session.lastFrame;
  }

  /* ---------------- page helpers ---------------- */

  async waitReady(page, timeout = NAV_TIMEOUT) {
    try { await page.waitForNetworkIdle({ idleTime: 500, timeout: Math.min(timeout, 15000) }); }
    catch (e) { try { await page.waitForFunction('document.readyState !== "loading"', { timeout: 8000 }); } catch (e2) {} }
  }

  async goto(session, url, opts = {}) {
    const target = cleanUrl(url);
    await session.page.goto(target, { waitUntil: opts.waitUntil || 'domcontentloaded', timeout: opts.timeout || NAV_TIMEOUT });
    if (opts.settle !== 0) await this.waitReady(session.page, opts.timeout || NAV_TIMEOUT);
    session.url = session.page.url();
    return this.snapshot(session, opts);
  }

  async snapshot(session, opts = {}) {
    const page = session.page;
    let info = { title: '', url: page.url(), text: '', scroll: null };
    try { info = await page.evaluate(PAGE_INFO_SCRIPT); } catch (e) {}
    let elements = [];
    try { elements = await page.evaluate(ELEMENT_SCRIPT); } catch (e) {}
    session.url = info.url || page.url();
    session.title = info.title || '';
    session.elements = elements;
    session.text = info.text || '';
    session.scroll = info.scroll || null;
    const limit = Number(opts.limit) || 0;
    return {
      ok: true,
      url: session.url,
      title: session.title,
      viewport: session.viewport,
      scroll: session.scroll,
      elementCount: elements.length,
      elements: opts.elements === false ? undefined : elements.slice(0, opts.elements === 'all' ? 400 : 60),
      text: limit ? (session.text || '').slice(0, limit) : undefined,
      frameAt: session.lastFrameAt
    };
  }

  async screenshot(session, opts = {}) {
    const buf = await session.page.screenshot({
      type: opts.type === 'png' ? 'png' : 'jpeg',
      quality: opts.type === 'png' ? undefined : Number(opts.quality) || 70,
      fullPage: !!opts.full,
      captureBeyondViewport: !!opts.full
    });
    return { buffer: buf, contentType: opts.type === 'png' ? 'image/png' : 'image/jpeg' };
  }

  async findElement(session, { ref, selector, text, nth = 0 }) {
    const page = session.page;
    if (ref) {
      const handle = await page.$('[data-webos-ref="' + ref + '"]');
      if (handle) return handle;
    }
    if (selector) {
      const handles = await page.$$(selector);
      if (handles[nth]) return handles[nth];
    }
    if (text) {
      const needle = String(text).toLowerCase();
      const handle = await page.evaluateHandle((needle) => {
        // input/textarea ka "text" nahi hota -> placeholder / aria-label / name bhi match karo,
        // taaki agent bina selector jaane "search" box me type kar sake
        function txt(el) {
          return (el.innerText || el.textContent || el.value || el.placeholder ||
            el.getAttribute('aria-label') || el.getAttribute('title') || el.name || el.id || '')
            .replace(/\s+/g, ' ').trim();
        }
        function vis(el) {
          var s = getComputedStyle(el);
          if (s.display === 'none' || s.visibility === 'hidden') return false;
          var r = el.getBoundingClientRect();
          return r.width > 1 && r.height > 1;
        }
        var all = Array.from(document.querySelectorAll('a,button,[role=button],input,textarea,select,label,summary'));
        var exact = all.find(function (e) { return vis(e) && txt(e).toLowerCase() === needle; });
        var starts = all.find(function (e) { return vis(e) && txt(e).toLowerCase().startsWith(needle); });
        var has = all.find(function (e) { return vis(e) && txt(e).toLowerCase().includes(needle); });
        return exact || starts || has || null;
      }, needle);
      const el = handle.asElement();
      if (el) return el;
    }
    return null;
  }

  async click(session, args = {}) {
    const page = session.page;
    let box = null;

    if (args.x != null && args.y != null) {
      box = { x: Number(args.x), y: Number(args.y), width: 1, height: 1 };
    } else {
      const el = await this.findElement(session, args);
      if (!el) return { ok: false, error: 'element nahi mila', tried: Object.keys(args).filter(k => args[k] != null) };
      await el.evaluate(node => node.scrollIntoView({ block: 'center', inline: 'center' }));
      await new Promise(r => setTimeout(r, 120));
      box = await el.boundingBox();
      if (!box) return { ok: false, error: 'element visible nahi hai (bounding box nahi mila)' };
      if (args.returnRef !== false) {
        try { session.lastClickedRef = await el.evaluate(node => node.getAttribute('data-webos-ref')); } catch (e) {}
      }
    }

    const cx = Math.round(box.x + (box.width || 1) / 2);
    const cy = Math.round(box.y + (box.height || 1) / 2);
    const before = page.url();
    await page.mouse.move(cx, cy, { steps: 3 });
    await page.mouse.click(cx, cy, { button: args.button || 'left', clickCount: Number(args.count) || 1 });
    session.actionCount++;
    session.lastAction = { action: 'click', at: cx + ',' + cy, ts: Date.now() };
    if (args.wait !== false) {
      await this.waitReady(page, 12000).catch(() => {});
      await new Promise(r => setTimeout(r, Number(args.settle) || 400));
    }
    const snap = await this.snapshot(session, { elements: args.elements === false ? false : 'all' });
    return { ok: true, clicked: { x: cx, y: cy, ref: session.lastClickedRef || null }, navigated: page.url() !== before, ...snap };
  }

  async type(session, args = {}) {
    const page = session.page;
    const text = String(args.text != null ? args.text : args.value != null ? args.value : '');
    if (args.x != null && args.y != null) {
      await page.mouse.click(Number(args.x), Number(args.y));
    } else if (args.ref || args.selector || args.text_selector || args.target) {
      const el = await this.findElement(session, {
        ref: args.ref, selector: args.selector || args.target, text: args.text_selector
      });
      if (!el) return { ok: false, error: 'input element nahi mila' };
      await el.evaluate(n => n.scrollIntoView({ block: 'center' }));
      await el.click({ clickCount: 3 }).catch(() => {});
    } else if (args.focus === false) {
      // jo focused hai usi me type karo
    } else {
      return { ok: false, error: 'ref / selector / x,y me se kuch do' };
    }

    if (args.clear !== false) {
      await page.keyboard.down('Control');
      await page.keyboard.press('KeyA');
      await page.keyboard.up('Control');
      await page.keyboard.press('Backspace');
    }
    await page.keyboard.type(text, { delay: Number(args.delay) || 25 });
    session.actionCount++;
    session.lastAction = { action: 'type', text: text.slice(0, 60), ts: Date.now() };

    let submitted = false;
    if (args.submit || args.enter || args.press === 'Enter') {
      await page.keyboard.press('Enter');
      submitted = true;
      await this.waitReady(page, 15000).catch(() => {});
      await new Promise(r => setTimeout(r, Number(args.settle) || 500));
    }
    const snap = await this.snapshot(session, { elements: 'all' });
    return { ok: true, typed: text.length, submitted, ...snap };
  }

  async press(session, args = {}) {
    const key = args.key || 'Enter';
    await session.page.keyboard.press(key);
    session.actionCount++;
    if (args.wait !== false) await new Promise(r => setTimeout(r, Number(args.settle) || 300));
    return { ok: true, key, ...(await this.snapshot(session, { elements: args.elements === false ? false : 'all' })) };
  }

  async scroll(session, args = {}) {
    const page = session.page;
    if (args.to === 'bottom') {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    } else if (args.to === 'top') {
      await page.evaluate(() => window.scrollTo(0, 0));
    } else if (args.selector || args.ref) {
      const el = await this.findElement(session, args);
      if (el) await el.evaluate(n => n.scrollIntoView({ block: args.block || 'center' }));
    } else {
      const dy = Number(args.y != null ? args.y : args.dy != null ? args.dy : 600);
      await page.mouse.move(session.viewport.width / 2, session.viewport.height / 2);
      await page.mouse.wheel({ deltaY: dy });
    }
    session.actionCount++;
    await new Promise(r => setTimeout(r, Number(args.settle) || 350));
    return { ok: true, ...(await this.snapshot(session, { elements: 'all' })) };
  }

  async evalJs(session, code) {
    if (!code) return { ok: false, error: 'code required' };
    try {
      const value = await session.page.evaluate((src) => {
        // eslint-disable-next-line no-new-func
        const fn = new Function('return (' + src + ')');
        return fn();
      }, String(code));
      return { ok: true, value: typeof value === 'object' ? JSON.stringify(value) : String(value) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /** readability-ish extraction, LLM ke prompt ke liye ready */
  async extract(session, opts = {}) {
    const page = session.page;
    const data = await page.evaluate(() => {
      function clean(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
      const main = document.querySelector('main, article, [role=main], #content, #main') || document.body;
      const links = Array.from(document.querySelectorAll('a[href]')).slice(0, 300).map(a => ({
        text: clean(a.innerText || a.textContent).slice(0, 140), href: a.href
      })).filter(l => l.text);
      const headings = Array.from(document.querySelectorAll('h1,h2,h3')).slice(0, 80)
        .map(h => ({ level: h.tagName.toLowerCase(), text: clean(h.innerText).slice(0, 200) })).filter(h => h.text);
      return {
        url: location.href, title: document.title,
        text: clean(main ? (main.innerText || main.textContent) : '').slice(0, 60000),
        headings, links,
        images: Array.from(document.images).slice(0, 40).map(i => ({ alt: i.alt, src: i.currentSrc || i.src })),
        meta: { description: (document.querySelector('meta[name=description]') || {}).content || '' }
      };
    });
    return { ok: true, ...data };
  }

  async back(session) { await session.page.goBack({ timeout: 30000 }).catch(() => {}); await this.waitReady(session.page).catch(() => {}); return this.snapshot(session, { elements: 'all' }); }
  async forward(session) { await session.page.goForward({ timeout: 30000 }).catch(() => {}); await this.waitReady(session.page).catch(() => {}); return this.snapshot(session, { elements: 'all' }); }
  async reload(session) { await session.page.reload({ timeout: 30000 }).catch(() => {}); await this.waitReady(session.page).catch(() => {}); return this.snapshot(session, { elements: 'all' }); }

  /** Manus-jaisa task runner: actions ki list step by step chalao */
  async runTask(actions, opts = {}) {
    const started = Date.now();
    let session = opts.sessionId ? this.getSession(opts.sessionId) : null;
    if (!session) session = await this.createSession({ width: opts.width, height: opts.height });
    const results = [];
    let failed = false;
    for (let i = 0; i < actions.length; i++) {
      const step = actions[i] || {};
      const type = String(step.action || step.type || step.op || '').toLowerCase();
      const t0 = Date.now();
      let res;
      try {
        switch (type) {
          case 'navigate': case 'goto': case 'open': res = await this.goto(session, step.url || step.value, step); break;
          case 'click': res = await this.click(session, step); break;
          case 'type': case 'fill': case 'input': res = await this.type(session, step); break;
          case 'press': case 'key': res = await this.press(session, step); break;
          case 'scroll': res = await this.scroll(session, step); break;
          case 'wait': await new Promise(r => setTimeout(r, Number(step.ms || step.value) || 1000)); res = { ok: true, waited: Number(step.ms || step.value) || 1000 }; break;
          case 'eval': res = await this.evalJs(session, step.code || step.value); break;
          case 'extract': case 'read': res = await this.extract(session, step); break;
          case 'screenshot': {
            const shot = await this.screenshot(session, step);
            res = { ok: true, bytes: shot.buffer.length, contentType: shot.contentType, note: 'screenshot /api/browser/' + session.id + '/screenshot se lo' };
            break;
          }
          case 'back': res = await this.back(session); break;
          case 'forward': res = await this.forward(session); break;
          case 'reload': res = await this.reload(session); break;
          case 'state': case 'snapshot': res = await this.snapshot(session, { elements: 'all' }); break;
          default: res = { ok: false, error: 'unknown action: ' + type };
        }
      } catch (e) {
        res = { ok: false, error: e.message };
      }
      const entry = { step: i, action: type, ok: res.ok !== false, ms: Date.now() - t0 };
      if (step.keep !== true) {
        entry.url = session.url;
        entry.title = session.title;
        if (res.ok === false) entry.error = res.error;
        // include: step-level ya task-level default ('text' | 'elements')
        const inc = step.include || (step.include === false ? false : opts.include);
        if (inc === 'text') entry.text = (session.text || '').slice(0, Number(step.limit) || Number(opts.limit) || 4000);
        else if (inc === 'elements' || step.includeElements) entry.elements = (session.elements || []).slice(0, Number(step.limit) || 40);
      }
      results.push(entry);
      if (res.ok === false && opts.stopOnError !== false) { failed = true; break; }
    }
    return {
      ok: !failed, sessionId: session.id, steps: results.length, total: actions.length,
      ms: Date.now() - started, results,
      final: opts.finalState === false ? undefined : { url: session.url, title: session.title }
    };
  }

  status() {
    return {
      engine: 'chromium',
      mode: this.mode,
      running: !!(this.browser && this.browser.connected),
      version: this.version || null,
      launching: !!this.launching,
      lastError: this.lastError,
      sessions: this.list(),
      maxSessions: MAX_SESSIONS,
      viewport: DEFAULT_VIEWPORT
    };
  }
}

module.exports = { ChromiumSessions, cleanUrl, ELEMENT_SCRIPT, PAGE_INFO_SCRIPT };
