# Signup flows — WebOS ke asli Chromium se (test report + fixes)

Ye doc us run ka record hai jisme WebOS ke **real headless Chromium** ko real signup flows pe chalaya
gaya — aur jo jo engine issues mile, wo fix kiye gaye.

`BASE` = WebOS server (local `http://localhost:3000` ya live `https://webos-inte.onrender.com`).

---

## 1. Complete flow (account ban gaya) — practice site

[automationexercise.com](https://automationexercise.com) automation practice ke liye hi bana hai.
**25/25 steps, ~13.5 seconds, ek hi `POST /api/browser/task` call:**

```json
{ "actions": [
  { "action": "navigate", "url": "https://automationexercise.com/signup" },
  { "action": "type",  "selector": "input[data-qa=\"signup-name\"]",  "text": "WebOS Agent" },
  { "action": "type",  "selector": "input[data-qa=\"signup-email\"]", "text": "webos.agent.<stamp>@example.com" },
  { "action": "click", "selector": "button[data-qa=\"signup-button\"]", "elements": false },
  { "action": "waitFor", "selector": "input[data-qa=\"password\"]" },
  { "action": "check", "selector": "#id_gender1" },
  { "action": "type",  "selector": "input[data-qa=\"password\"]", "text": "Agent@12345" },
  { "action": "select", "selector": "#days",   "value": "10" },
  { "action": "select", "selector": "#months", "value": "5" },
  { "action": "select", "selector": "#years",  "value": "1995" },
  { "action": "check", "selector": "#newsletter" },
  { "action": "check", "selector": "#optin" },
  { "action": "type",  "selector": "input[data-qa=\"first_name\"]", "text": "Web" },
  { "action": "type",  "selector": "input[data-qa=\"last_name\"]",  "text": "Agent" },
  { "action": "type",  "selector": "input[data-qa=\"address\"]",    "text": "42 Agent Street" },
  { "action": "select", "selector": "select[data-qa=\"country\"]",  "value": "India" },
  { "action": "type",  "selector": "input[data-qa=\"state\"]",   "text": "UP" },
  { "action": "type",  "selector": "input[data-qa=\"city\"]",    "text": "Varanasi" },
  { "action": "type",  "selector": "input[data-qa=\"zipcode\"]", "text": "221001" },
  { "action": "type",  "selector": "input[data-qa=\"mobile_number\"]", "text": "9876543210" },
  { "action": "click", "selector": "button[data-qa=\"create-account\"]", "elements": false },
  { "action": "waitFor", "text": "ACCOUNT CREATED", "timeout": 25000 },
  { "action": "screenshot" }
] }
```

Result: `ACCOUNT CREATED!` page (`/account_created`) — screenshots `screenshots-signup/signup-local-created.jpg`,
form bharne ka shot `screenshots-signup/signup-form-filled.jpg`.

---

## 2. Gmail (Google) signup — phone-verification gate tak

Screenshots: `screenshots-signup/gmail-*.jpg`, notes: `screenshots-signup/gmail-flow-notes.txt`

| step | kya hua |
|---|---|
| 1 | `accounts.google.com/signup` khula, First/Last name bhara → **Next** (real mouse click) |
| 2 | birthday page: Month/Gender **custom dropdowns** (`role=combobox`, native `<select>` nahi) — `select` op se chune, `Day`/`Year` type kiye → Next |
| 3 | **"Create an email address"** page: Google ne naam se suggestions diye (`agentweb64@gmail.com` …) |
| 4 | styled radio (opacity:0) `Create your own Gmail address` ko `check` kiya → username box khula |
| 5 | username type kiya → Next → **"Create a strong password"** page, `Passwd` + `PasswdAgain` bhare |
| ✋ | **Yahan rok diya** — agla step account submit + **phone number verification (SMS code)** + CAPTCHA hai |

## 3. Render signup — hCaptcha gate tak

Screenshots: `screenshots-signup/render-*.jpg`

* `dashboard.render.com/register` pe email + password fields agent ne bhare — screenshot me form bhara hua dikhta hai.
* Page khud bolta hai: **"This site is protected by hCaptcha"** — aur submit karne pe captcha + phir email verification lagta hai.
* Yahin rok diya (neeche reason).

---

## 4. Ye kyun rok diya (honest part)

* **Gmail**: account create karne ke liye Google phone verification (SMS) aur CAPTCHA maangta hai.
  Usse bypass karna na technically reliable hai, na theek — isliye WebOS **human-in-the-loop** deta hai:
  same live session (Chromium app ka live view) me aap khud verification kar sakte ho, agent tab tak rukta hai,
  phir aage ka kaam agent kar sakta hai.
* **Render**: signup hCaptcha + email verification se protected hai. Uske liye **temp-mail / Gmail dot-trick alias**
  use karke account banana matlab fake account banana (aur service ke ToS ke khilaf) — wo maine nahi kiya.
  Aapka Render account already hai; wahan kaam karane ke liye agent ko aapka real login chahiye (ya API key).
* Isi wajah se repo `instant-mail-cli` (temp mail + OTP watcher) ko signup automation me **wire nahi kiya gaya** —
  wo tool alag kaam ke liye theek hai, par usse third-party accounts banana abuse ban jaata hai.

---

## 5. Jo issues mile aur fix hue (ye asli kaam tha)

Signup flows chalane se engine ke ye gaps nikle — sab fix ho gaye:

| # | Issue | Fix |
|---|---|---|
| 1 | `<select>` dropdown ko handle karne wala koi op nahi tha | naya **`select`** action (`value`/`option`/`text`/`index`) — native `<select>` + `change` event |
| 2 | Google jaisi sites **custom dropdown** use karti hain (`role=combobox`, native select nahi) | `select` ab custom dropdown bhi kholta hai, `[role=option]` list se text-match click karta hai; fail hone par keyboard (ArrowDown + Enter) fallback |
| 3 | checkbox/radio ka koi op nahi tha | naya **`check` / `uncheck`** — asli click, aur styled (`opacity:0`) inputs ke liye label/DOM-click fallback + state verify |
| 4 | Multi-step forms me "agla page aaya ya nahi" ka koi tareeka nahi tha | naya **`waitFor`** — `selector`, `text`, `url`, `gone`, `ms`, `timeout` |
| 5 | iframe ke andar wale forms ke elements miss ho jaate the | **frames support**: `/frames` endpoint + `findElement` ab child frames me bhi dhundta hai |
| 6 | Google signup page pe `body.innerText` **blank** aata tha (text extraction fail) | text nikalne ka fallback: visible-only deep DOM walk (script/style skip, shadow DOM bhi) |
| 7 | Styled radio/checkbox (`opacity: 0`) aur unke `<label>` element list me nahi aate the — agent unhe dekh hi nahi paata tha | element collector: `opacity:0` wale elements + `label` + `[role=radio/checkbox/switch]` + **shadow DOM roots**, dedupe |
| 8 | `/api/browser/<id>/waitFor` (camelCase) 404 de raha tha | verbs ab case-insensitive (`waitFor` = `waitfor`) |
| 9 | Task runner me `wait_for` / `waitFor` jaisi names confuse karti thi | action names normalize (case + `_`/`-` ignore) |
| 10 | Har response me page text sirf tab aata tha jab `limit` diya ho — agent ko context nahi milta tha | snapshot ab **text ka 1500-char preview + `textLength`** hamesha bhejta hai |
| 11 | Hidden/size-0 inputs pe click fail ho jaata tha | click fallback: pehle `<label>`, phir DOM click; mouse click fail hone par bhi DOM fallback |
| 12 | Page transition ke beech snapshot khali aa jaata tha | snapshot me ek chhota retry (text blank ho to) |

---

## 6. External agent ke liye copy-paste

```bash
BASE=https://webos-inte.onrender.com

# 1) session
SID=$(curl -s -X POST $BASE/api/browser -H 'content-type: application/json' \
      -d '{"url":"https://example.com"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["sessionId"])')

# 2) naye actions
curl -s -X POST $BASE/api/browser/$SID/select  -H 'content-type: application/json' -d '{"selector":"select[data-qa=\"country\"]","value":"India"}'
curl -s -X POST $BASE/api/browser/$SID/check   -H 'content-type: application/json' -d '{"selector":"#newsletter","checked":true}'
curl -s -X POST $BASE/api/browser/$SID/waitfor -H 'content-type: application/json' -d '{"text":"ACCOUNT CREATED","timeout":25000}'
curl -s -X POST $BASE/api/browser/$SID/hover   -H 'content-type: application/json' -d '{"text":"Products"}'
curl -s $BASE/api/browser/$SID/frames

# 3) ya poora flow ek call me
curl -s -X POST $BASE/api/browser/task -H 'content-type: application/json' \
  -d '{"actions":[{"action":"navigate","url":"https://automationexercise.com/signup"},{"action":"extract","keep":true}]}'
```

Task (OS ke Chromium app me bhi): **Task tab → "Preset: signup flow (24 steps)"** — ek click me poora
form bhar ke `ACCOUNT CREATED` tak chala jaata hai, live view me sab dikhta hai.
