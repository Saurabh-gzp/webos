/* ============================================================
   bridge.js — connects the GUI (this browser tab) to the agent bus
   - upstream   : SSE  /api/agent/stream
   - downstream : POST /api/agent/result
   - state      : POST /api/agent/report  (windows, browser page, DOM refs…)
   ============================================================ */
(function () {
  'use strict';

  const CLIENT_ID = 'web-' + Math.random().toString(36).slice(2, 10);
  WebOS.clientId = CLIENT_ID;

  const pill = () => document.getElementById('agentPill');
  const pillText = () => document.getElementById('agentPillText');
  let es = null;
  let connected = false;
  let busyCount = 0;
  let lastError = '';
  const cmdHistory = [];

  function setPill(state, text) {
    const p = pill();
    if (!p) return;
    p.classList.toggle('on', state === 'on');
    p.classList.toggle('busy', state === 'busy');
    if (pillText()) pillText().textContent = text || (state === 'on' ? 'agent' : 'offline');
  }

  async function sendReport(state) {
    try {
      await fetch('/api/agent/report', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientId: CLIENT_ID, state: state || WebOS.state() })
      });
    } catch (e) { /* offline is fine */ }
  }

  async function sendResult(id, result) {
    try {
      await fetch('/api/agent/result', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientId: CLIENT_ID, id, result })
      });
    } catch (e) { /* ignore */ }
  }

  WebOS.on('state', () => sendReport());

  /* ---------------- command execution ---------------- */
  const seen = new Set();      // dedupe: SSE + inbox poll may both deliver a command
  const inflight = new Set();

  async function execute(cmd) {
    if (!cmd || !cmd.id) return;
    if (seen.has(cmd.id) || inflight.has(cmd.id)) return;
    inflight.add(cmd.id);
    seen.add(cmd.id);
    if (seen.size > 300) seen.delete(seen.values().next().value);
    busyCount++;
    setPill('busy', 'working');
    const started = Date.now();
    let result;
    try {
      result = await WebOS.handleCommand(cmd);
      if (!result || typeof result !== 'object') result = { ok: true, value: result };
    } catch (e) {
      result = { ok: false, error: String(e && e.message || e) };
    }
    inflight.delete(cmd.id);
    result.ms = Date.now() - started;
    result.ts = Date.now();
    cmdHistory.push({ op: cmd.op, args: cmd.args, ok: result.ok !== false, ms: result.ms, error: result.error, ts: Date.now() });
    if (cmdHistory.length > 60) cmdHistory.shift();
    busyCount--;
    setPill(busyCount > 0 ? 'busy' : (connected ? 'on' : 'off'), busyCount > 0 ? 'working' : (connected ? 'agent' : 'offline'));
    await sendResult(cmd.id, result);
    await sendReport();
  }

  /* ---------------- SSE ---------------- */
  function connect() {
    try {
      if (es) es.close();
      es = new EventSource('/api/agent/stream?clientId=' + encodeURIComponent(CLIENT_ID));
      es.onopen = () => { connected = true; setPill(busyCount ? 'busy' : 'on', busyCount ? 'working' : 'agent'); };
      es.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch (e) { return; }
        if (msg.type === 'hello') { connected = true; setPill(busyCount ? 'busy' : 'on', busyCount ? 'working' : 'agent'); sendReport(); return; }
        if (msg.type === 'cmd' && msg.cmd) execute(msg.cmd);
      };
      es.onerror = () => {
        connected = false; setPill('off', 'offline');
        try { es.close(); } catch (e) {}
        setTimeout(connect, 2500);
      };
    } catch (e) {
      setTimeout(connect, 3000);
    }
  }

  /* ---------------- fallback inbox poll ----------------
     Some hosting platforms buffer (or strip) event-streams. Polling the inbox
     guarantees the agent's commands still reach the GUI. Duplicates are
     suppressed by the `seen` set above. */
  async function pollInbox() {
    try {
      const r = await fetch('/api/agent/inbox?clientId=' + encodeURIComponent(CLIENT_ID));
      const j = await r.json();
      (j.commands || []).forEach(execute);
    } catch (e) { /* offline */ }
  }
  setInterval(pollInbox, 1200);

  /* ---------------- keepalive state pushes ---------------- */
  setInterval(() => { if (connected) sendReport(); }, 8000);
  window.addEventListener('beforeunload', () => { try { es && es.close(); } catch (e) {} });

  WebOS.bridge = {
    clientId: CLIENT_ID,
    connected: () => connected,
    history: () => cmdHistory.slice(-30),
    reconnect: connect
  };

  if (document.readyState === 'complete' || document.readyState === 'interactive') setTimeout(connect, 400);
  else window.addEventListener('DOMContentLoaded', () => setTimeout(connect, 400));
})();
