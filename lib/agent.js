'use strict';
/**
 * Agent bus -- the bridge that lets an external agent (curl / LLM / script)
 * drive the GUI which is running inside the user's browser.
 *
 *   agent  --POST /api/agent/cmd-->  server queue  --SSE-->  browser shell
 *   agent  <--result / state--------- server  <--POST---  browser shell
 *
 * Long polling: cmd?wait=1 & timeout=<ms> resolves as soon as the client answers.
 */
const { EventEmitter } = require('events');

let seq = 0;

class AgentBus {
  constructor() {
    this.clients = new Map();   // clientId -> { id, res (SSE), lastSeen, ua }
    this.primary = null;        // clientId of the most recently active client
    this.queue = [];            // pending commands for the primary client
    this.inbox = new Map();     // clientId -> [cmd]  (fallback delivery if SSE is buffered)
    this.pending = new Map();   // id -> { resolve, timer }
    this.stateData = { windows: [], focused: null, browser: null, notifications: [], desktop: {}, ts: 0 };
    this.log = [];              // agent activity log (for the Agent Console app)
    this.events = new EventEmitter();
    this.events.setMaxListeners(50);
  }

  /* ---------- client connection ---------- */

  addClient(id, res, ua) {
    this.clients.set(id, { id, res, lastSeen: Date.now(), ua });
    this.primary = id;
    this.pushLog('system', 'client connected: ' + id);
    // Flush anything queued while nobody was listening
    if (this.queue.length) this.flush(id);
    return id;
  }

  removeClient(id) {
    const c = this.clients.get(id);
    if (c && c.res) { try { c.res.end(); } catch (e) {} }
    this.clients.delete(id);
    if (this.primary === id) {
      const rest = [...this.clients.keys()];
      this.primary = rest.length ? rest[rest.length - 1] : null;
    }
    this.pushLog('system', 'client disconnected: ' + id);
  }

  touch(id) { const c = this.clients.get(id); if (c) { c.lastSeen = Date.now(); this.primary = id; } }
  clientCount() { return this.clients.size; }

  send(id, payload) {
    const c = this.clients.get(id);
    if (!c || !c.res) return false;
    try { c.res.write('data: ' + JSON.stringify(payload) + '\n\n'); return true; } catch (e) { return false; }
  }

  target() {
    if (this.primary && this.clients.has(this.primary)) return this.primary;
    const keys = [...this.clients.keys()];
    return keys.length ? keys[keys.length - 1] : null;
  }

  /* ---------- state reported by the client ---------- */

  report(state) {
    this.stateData = { ...this.stateData, ...state, ts: Date.now() };
  }

  state() {
    return {
      connected: this.clientCount() > 0,
      clients: this.clientCount(),
      ts: this.stateData.ts,
      ...this.stateData,
      queueDepth: this.queue.length
    };
  }

  pushLog(kind, text, extra) {
    const entry = { seq: ++seq, ts: Date.now(), kind, text: String(text).slice(0, 2000), ...(extra || {}) };
    this.log.push(entry);
    if (this.log.length > 500) this.log.shift();
    this.events.emit('log', entry);
    return entry;
  }

  /* ---------- command dispatch ---------- */

  /** Send a command to the GUI; resolves with the client's result (or an error). */
  dispatch(cmd, timeoutMs = 15000) {
    const id = 'c' + (++seq) + '-' + Math.random().toString(36).slice(2, 7);
    const payload = { id, op: cmd.op, app: cmd.app, args: cmd.args || {}, ts: Date.now() };
    const targetId = this.target();
    this.pushLog('cmd', cmd.op + (cmd.app ? ' ' + cmd.app : ''), { id, args: cmd.args || {} });

    if (!targetId) {
      return Promise.resolve({
        ok: false, id, op: cmd.op,
        error: 'no WebOS client connected -- open the OS in a browser tab first',
        state: this.state()
      });
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.pushLog('timeout', cmd.op + ' timed out', { id });
        resolve({ ok: false, id, op: cmd.op, error: 'timeout after ' + timeoutMs + 'ms', state: this.state() });
      }, Math.max(1500, Math.min(timeoutMs, 120000)));

      this.pending.set(id, { resolve, timer, cmd: payload });
      const sent = this.send(targetId, { type: 'cmd', cmd: payload });
      if (!sent) this.queue.push(payload);
      // always mirror into the inbox: the GUI dedupes by command id, so this is
      // a pure safety net for platforms that buffer event-streams
      const box = this.inbox.get(targetId) || [];
      box.push(payload);
      while (box.length > 40) box.shift();
      this.inbox.set(targetId, box);
      // safety: if the SSE pipe silently died, try every other client
      setTimeout(() => {
        if (this.pending.has(id) && !sent) {
          for (const [cid] of this.clients) { if (this.send(cid, { type: 'cmd', cmd: payload })) break; }
        }
      }, 400);
    });
  }

  /** commands waiting for a client (fallback channel; client dedupes by id) */
  drainInbox(clientId) {
    const box = this.inbox.get(clientId);
    if (!box) return [];
    const cutoff = Date.now() - 3 * 60 * 1000;
    const fresh = box.filter(c => c.ts >= cutoff);
    this.inbox.set(clientId, fresh);
    return fresh;
  }

  /** client says "I ran these" -> forget them everywhere */
  ackCommands(clientId, ids) {
    if (!ids || !ids.length) return 0;
    let n = 0;
    for (const [cid, box] of this.inbox) {
      const next = box.filter(c => !ids.includes(c.id));
      n += box.length - next.length;
      this.inbox.set(cid, next);
    }
    return n;
  }

  deliverResult(id, result) {
    const p = this.pending.get(id);
    if (p) {
      clearTimeout(p.timer);
      this.pending.delete(id);
      this.pushLog(result && result.ok === false ? 'error' : 'ok', (p.cmd.op || 'cmd') + (result && result.error ? ': ' + result.error : ''), { id });
      p.resolve({ ok: true, id, op: p.cmd.op, ...(result || {}) });
      this.ackCommands(null, [id]);
      return true;
    }
    return false;
  }

  flush(clientId) {
    const q = this.queue.splice(0, this.queue.length);
    for (const payload of q) this.send(clientId, { type: 'cmd', cmd: payload });
    return q.length;
  }
}

module.exports = { AgentBus };
