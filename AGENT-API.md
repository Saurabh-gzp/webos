# WebOS Agent API

Ye ek **browser-based operating system** hai jise koi bhi agent (LLM, script, cron, MCP tool)
poori tarah operate kar sakta hai. GUI browser me chalta hai, control HTTP se hota hai.

Base URL: `http://localhost:3000` (ya aapka host/port). Saare endpoints **CORS enabled** hain.

---

## 0. Ek line me samajh

```
agent ──POST /api/agent/cmd──► server ──SSE / inbox──► browser GUI
agent ◄──── result (wait) ───── server ◄──POST /api/agent/result──┘
```

Isliye agent ko browser ke andar chalne wale JS ki zaroorat nahi — sirf HTTP chahiye.
Windows, browser tabs, page DOM refs, text — sab `/api/agent/state` me live milta hai.

> **Client connected hona chahiye.** OS ka tab browser me khula hona chahiye; tab tak
> `/api/agent/state` me `connected:false` aayega. Agent commands queue ho jaati hain.

---

## 1. State padho

```bash
curl -s localhost:3000/api/agent/state | jq
```

```json
{
  "connected": true,
  "clients": 1,
  "windows": [{"id":"w1","app":"browser","title":"Browser","focused":true,"rect":{...}}],
  "focused": "w1",
  "apps": [{"id":"browser","name":"Browser","icon":"🌐"}, ...],
  "appState": {
    "browser": {
      "url": "https://en.wikipedia.org/wiki/Operating_system",
      "title": "Operating system - Wikipedia",
      "tabs": [{"id":"t1","url":"…","title":"…","active":true}],
      "elements": [{"ref":12,"kind":"link","text":"History","href":"…","rect":[x,y,w,h]}],
      "elementCount": 400,
      "textPreview": "Home Random Nearby …",
      "searchResults": []
    },
    "editor": {"path":"/Home/Documents/notes.txt","dirty":false},
    "files": {"cwd":"/Home","entries":[…]},
    "terminal": {"cwd":"/Home"}
  },
  "notifications": [{"text":"…","kind":"ok"}]
}
```

---

## 2. Command bhejo (main endpoint)

```bash
curl -s localhost:3000/api/agent/cmd \
  -H 'content-type: application/json' \
  -d '{"op":"navigate","app":"browser","args":{"url":"https://news.ycombinator.com"},"wait":true}'
```

* `op` — kya karna hai (neeche list)
* `app` — kaunse app ko target karna hai (optional; default = focused window)
* `args` — op ke hisaab se parameters
* `wait: true` — result aane tak HTTP response ruko (default). `wait:false` → turant `202 queued`.
* `timeout` — ms (default 15000, max 120000)

Response: `{"ok":true,"handledBy":"browser","windowId":"w1", ...op-specific fields}`.

---

## 3. Ops

### Window manager (kernel)

| op | args | kya karta hai |
|---|---|---|
| `open` | `{app:"browser", url:"…"}` / `{app:"editor", path:"…"}` | app window kholta hai (`windowId` return) |
| `close` / `closeall` | `{app}` ya `{window:"w1"}` | window band |
| `focus`, `minimize`, `maximize`, `restore` | `{app}` ya `{window}` | window state |
| `move` | `{app, left, top, width, height}` | window position/size |
| `windows` | — | open windows ki list |
| `apps` | — | installed apps |
| `notify` | `{text, kind:"ok\|err\|warn", title}` | desktop notification |
| `theme` | `{mode:"dark"\|"light", accent:"#35d07f"}` | theme |
| `wallpaper` | `{css:"linear-gradient(…)"}` | desktop wallpaper |
| `titlebar` | `{app, title}` | window ka title badlo |

### Browser (in-OS browser)

| op | args | kya karta hai |
|---|---|---|
| `navigate` | `{url, newTab?}` | URL kholo (ya search: `search` op) |
| `search` | `{q}` | Web search + results (structured list + rendered page) |
| `back` / `forward` / `reload` / `home` | — | history |
| `read` | `{mode:"auto\|text\|elements", limit}` | page ka text + interactive elements |
| `links` / `inputs` | — | sirf links ya form fields (refs ke saath) |
| `click` | `{ref:12}` ya `{text:"Sign in"}` | element click (text match smart hai) |
| `type` | `{ref, text, submit:true}` ya `{field:0, text, submit}` | input me likho + optionally submit |
| `press` | `{key:"Enter"}` | key event |
| `scroll` | `{y:800}` ya `{y:"bottom"}` | scroll |
| `eval` | `{code:"document.title"}` | page ke andar JS chalao (sandboxed) |
| `extract` | `{url, limit}` | **bina page kholne** kisi URL ka text (server-side reader) |
| `tabs` / `newtab` / `closetab` / `switchtab` | `{id}` / `{index}` | tab management |
| `panel` | `{mode:"elements\|text\|tools\|off"}` | side panel |

### Real Chromium (headless Chromium session — Manus-jaisa)

Iframe wala browser proxy pe chalta hai (kuch sites rok deti hain). Iske saath **asli Chromium**
bhi chalta hai — server pe headless Chromium, jisme agent ko real mouse/keyboard/vision milta hai.
Sab kuch HTTP se, isliye koi external agent (Manus AI style) ise easily drive kar sakta hai.

| endpoint | kya karta hai |
|---|---|
| `POST /api/browser` | nayi session: `{url?, width?, height?}` → `{sessionId}` (pehli baar Chromium launch hota hai ~1s) |
| `GET  /api/browser/status` | engine running?, version, saari sessions |
| `GET  /api/browser/sessions` | session list · `DELETE` → sab band |
| `POST /api/browser/task` | **ek hi call me poora task**: `{actions:[{action,…}], sessionId?, stopOnError?, finalState?}` |
| `POST /api/browser/<id>/navigate` | `{url, waitUntil?, settle?}` → title, url, elements[], text |
| `POST /api/browser/<id>/act` | `{action:"click\|type\|press\|scroll\|eval\|extract\|screenshot\|back\|forward\|reload\|state", …}` |
| `POST /api/browser/<id>/click` | `{ref}` ya `{text:"Sign in"}` ya `{selector}` ya `{x,y}` — asli mouse click |
| `POST /api/browser/<id>/type` | `{ref\|selector\|text_selector\|x,y, text, submit?:true, clear?}` — asli keyboard |
| `POST /api/browser/<id>/press` | `{key:"Enter\|Tab\|PageDown…"}` |
| `POST /api/browser/<id>/scroll` | `{y:800}` ya `{to:"bottom"}` ya `{ref}` (element tak) |
| `POST /api/browser/<id>/eval` | `{code:"document.title"}` |
| `GET  /api/browser/<id>/state` | url, title, scroll, elements[] (stable refs), text |
| `GET  /api/browser/<id>/extract` | reader-jaisa output: text + headings + links + images |
| `GET  /api/browser/<id>/screenshot?full=1&type=png` | **asli screenshot** (JPEG/PNG binary — vision models ke liye) |
| `GET  /api/browser/<id>/frame` | last screencast frame (base64 JPEG, halka) |
| `GET  /api/browser/<id>/stream` | **SSE live view**: screencast frames + nav events (UI isi se live dikhata hai) |
| `POST /api/browser/<id>/close` | session band (Chromium idle hone par khud bhi band ho jata hai) |

Agent bus se bhi wahi kaam (GUI window khuli ho ya na ho):

```
POST /api/agent/cmd {"op":"chromium.open",  "args":{"url":"https://news.ycombinator.com"}}
POST /api/agent/cmd {"op":"chromium.goto",  "args":{"url":"https://example.com"}}
POST /api/agent/cmd {"op":"chromium.act",   "args":{"action":"click","text":"Sign in"}}
POST /api/agent/cmd {"op":"chromium.act",   "args":{"action":"type","text":"hello","submit":true}}
POST /api/agent/cmd {"op":"chromium.act",   "args":{"action":"extract"}}
POST /api/agent/cmd {"op":"chromium.screenshot"}          → VFS me save: {path:"/Home/Screenshots/shot-….jpg"}
POST /api/agent/cmd {"op":"chromium.task",  "args":{"actions":[…]}}
POST /api/agent/cmd {"op":"chromium.status"}
```

**Manus-style ek-call task** (research → click → padho → screenshot):

```bash
curl -X POST https://webos-inte.onrender.com/api/browser/task -H 'content-type: application/json' -d '{
  "actions": [
    {"action": "navigate", "url": "https://news.ycombinator.com"},
    {"action": "click",    "text": "new"},
    {"action": "extract",  "keep": true},
    {"action": "screenshot"}
  ]
}'
```

Task actions: `navigate · click · type · press · scroll · wait {ms} · eval · extract/read · screenshot ·
back · forward · reload · state`. Har step ka result milta hai (`ok`, `ms`, `url`, `title`, error) aur
`sessionId` lauta kar aap wahi session aage drive kar sakte ho (cookies/login bane rehte hain).

**Element refs:** `state`/`navigate` ke response me har link/button/input ka `ref` aata hai
(`{ref, kind, tag, text, rect, inView}`). `click {ref}` / `type {ref, text}` refs ko use karo —
refs page ke saath stable rehte hain. Ref ke bina `{"text":"Sign in"}` bhi chalta hai (placeholder /
aria-label / name match hota hai, isliye "Search" jaise input bina selector jaane mil jaate hain).

**Live view:** `GET /api/browser/<id>/stream` (SSE) se frames stream hote hain — OS ke Chromium app
window ka left side wahi hai, aur human wahan click/scroll/keyboard bhi kar sakta hai (same session,
same cookies). UI: desktop icon **🌐 Chromium**.

### Filesystem / shell / editor

| op | endpoint | args |
|---|---|---|
| `shell` | `POST /api/agent/cmd` (app:`terminal`) | `{cmd:"mkdir /Home/x && ls", cwd:"/Home"}` |
| direct | `POST /api/exec` | `{cmd, cwd}` — GUI ke bina bhi chalta hai |
| list / read / write / mkdir / rm / move | `GET/POST /api/fs/*` | `path`, `content`, `from`, `to` |
| `edit` | app:`editor` | `{text:"…", save:true}` / `append` |
| `saveas` | app:`editor` | `{path:"/Home/a.md"}` |
| `calc` | app:`calc` | `{expr:"(3+4)*12"}` |
| `doc` | app:`docs` | `{page:"index"\|"shortcuts"}` |
| `tone` | app:`music` | `{name:"startup"}` |

### GUI-less endpoints (browser ke bina bhi kaam karte hain)

```
GET  /api/proxy/text?url=…      → {title, text, links[]}       (reader mode)
GET  /api/search?q=…            → {engine, results[]}          (DDG → Bing → Bing RSS fallback)
GET  /api/fs/list?path=/Home    → entries
GET  /api/fs/read?path=…        → content
POST /api/fs/write              → {path, content}
GET  /api/agent/log             → agent activity log
POST /api/browser               → nayi REAL Chromium session (headless Chrome)
POST /api/browser/task          → {actions:[…]} Manus-style multi-step task
GET  /api/browser/<id>/screenshot → image/jpeg | image/png (vision ke liye)
GET  /api/browser/<id>/stream   → SSE live screencast (text/event-stream)
GET  /api/meta                  → version, apps, endpoints
GET  /api/ping                  → health
```

---

## 4. Typical agent loops

**A. "Ye page padho aur summary banao"**

```bash
curl -s localhost:3000/api/agent/cmd -d '{"op":"navigate","args":{"url":"https://en.wikipedia.org/wiki/WebOS"}}' -H 'content-type: application/json'
curl -s localhost:3000/api/agent/cmd -d '{"op":"read","args":{"mode":"text","limit":8000}}' -H 'content-type: application/json'
```

**B. "Search karo aur pehla result kholo"**

```bash
R=$(curl -s localhost:3000/api/agent/cmd -H 'content-type: application/json' \
     -d '{"op":"search","args":{"q":"webos operating system"},"app":"browser"}')
URL=$(echo "$R" | jq -r '.results[0].url')
curl -s localhost:3000/api/agent/cmd -H 'content-type: application/json' \
     -d "{\"op\":\"navigate\",\"args\":{\"url\":\"$URL\"},\"app\":\"browser\"}"
```

**C. "Form bharo"**

```bash
curl -s localhost:3000/api/agent/cmd -H 'content-type: application/json' \
  -d '{"op":"type","args":{"field":0,"text":"webos browser automation","submit":true},"app":"browser"}'
```

**D. "Report likho"**

```bash
curl -s localhost:3000/api/agent/cmd -H 'content-type: application/json' \
  -d '{"op":"open","app":"editor","args":{"path":"/Home/Documents/report.md"}}'
curl -s localhost:3000/api/agent/cmd -H 'content-type: application/json' \
  -d '{"op":"edit","app":"editor","args":{"text":"# Report\n\nSab kaam ho gaya.\n","save":true}}'
```

**E. Ready-made CLI**

```bash
node tools/agent-cli.js state
node tools/agent-cli.js search "best laptops 2026"
node tools/agent-cli.js click "Sign in"
node tools/agent-cli.js type 3 "hello" --submit
node tools/agent-cli.js shell "mkdir /Home/agent && ls /Home"
```

---

## 5. LLM ke liye tool schema (copy-paste)

```json
[
  {"name":"webos_state","description":"Poora OS state — windows, focused app, browser page, elements, files","parameters":{"type":"object","properties":{}}},
  {"name":"webos_cmd","description":"WebOS par koi bhi operation chalao","parameters":{"type":"object","required":["op"],"properties":{
      "op":{"type":"string","enum":["open","close","focus","maximize","minimize","move","notify","theme","wallpaper","navigate","search","read","links","inputs","click","type","press","scroll","eval","extract","tabs","newtab","switchtab","shell","edit","calc"]},
      "app":{"type":"string","description":"browser | files | editor | terminal | docs | settings | monitor | calc | music | agent"},
      "args":{"type":"object","description":"op specific — e.g. {\"url\":\"https://…\"}, {\"ref\":12}, {\"field\":0,\"text\":\"hi\",\"submit\":true}"},
      "wait":{"type":"boolean","default":true}}}},
  {"name":"webos_shell","description":"WebOS shell command (ls, cat, mkdir, write, open, browse, read, search…)","parameters":{"type":"object","required":["cmd"],"properties":{"cmd":{"type":"string"},"cwd":{"type":"string"}}}},
  {"name":"webos_read_url","description":"Kisi bhi URL ka readable text (bina browser kholne)","parameters":{"type":"object","required":["url"],"properties":{"url":{"type":"string"}}}}
]
```

---

## 6. Notes / limitations

* Kitni bhi site `iframe` me nahi chalti — jo sites `X-Frame-Options: DENY` bhejti hain
  (Google search, kuch banks, kuch govt sites) unka full UI proxy me bhi block ho sakta hai.
  Unke liye `read` / `extract` (server-side text) use karo — wo hamesha kaam karta hai.
* Search engine fallback automatic hai aur **cloud IPs (Render/Vercel) ke liye tuned** hai:
  SearXNG pool → Marginalia → Bing HTML → Bing RSS → Brave → DuckDuckGo → Google News → Wikipedia.
  Har engine ke results ek relevance filter se guzarte hain (junk/off-topic feed reject hota hai).
  `GET /api/search?q=…` ke response me `engine` + `errors` fields dekho ki kaunsa chala.
  Results 3 minute cache hote hain (`cached: true`), aur rate-limited SearXNG instance 10 min skip hota hai.
* Har `click`/`type` ke baad page ka naya snapshot 200-1200ms me aata hai; `settle` arg se
  wait badha sakte ho (`{"op":"click","args":{"ref":5,"settle":2000}}`).
* Agent Console app (desktop pe) me live activity dekho: kaunsi op aayi, kya result mila.
