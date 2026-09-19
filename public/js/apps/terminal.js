/* ============ Terminal — WebOS shell ============ */
(function () {
  'use strict';
  function mk(t, c, h) { const n = document.createElement(t); if (c) n.className = c; if (h != null) n.innerHTML = h; return n; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  WebOS.registerApp({
    id: 'terminal', name: 'Terminal', icon: '⌨️', width: 760, height: 460,
    mount(a) {
      let cwd = (a.args && (a.args.cwd || a.args.path)) || '/Home';
      const sessionId = 'term-' + a.win.id;
      const hist = [];
      let hp = -1;

      const root = a.win.body;
      const out = mk('div', 'term');
      const row = mk('div', 'term-input-row');
      row.innerHTML = `<span class="ps1"></span><input spellcheck="false" autocomplete="off" placeholder="type a command… (help)">`;
      root.appendChild(out); root.appendChild(row);

      const ps1 = row.querySelector('.ps1');
      const input = row.querySelector('input');
      const setPs1 = () => { ps1.textContent = 'agent@webos:' + cwd + '$'; a.setTitle('Terminal', cwd); };

      function print(text, cls) {
        const d = mk('div', 'line ' + (cls || ''), esc(text));
        out.appendChild(d);
        out.scrollTop = out.scrollHeight;
      }
      function printf(html, cls) {
        const d = mk('div', 'line ' + (cls || ''), html);
        out.appendChild(d);
        out.scrollTop = out.scrollHeight;
      }

      print('WebOS shell 1.0  —  `help` likho commands ke liye, `apps` se saare apps dekho');
      print('');

      async function exec(line) {
        if (!line.trim()) return;
        hist.push(line); hp = hist.length;
        printf('<span class="cmd">agent@webos:' + esc(cwd) + '$</span> ' + esc(line));
        try {
          const r = await WebOS.api.shell(line, cwd);
          if (r.out === '__CLEAR__') { out.innerHTML = ''; }
          else if (r.out) print(r.out, r.code === 0 ? '' : 'err');
          if (r.cwd && r.cwd !== cwd) { cwd = r.cwd; setPs1(); }
          if (r.code !== 0 && r.out && !r.out.trim().startsWith('command not found')) { /* already printed */ }
          a.publishState({ cwd, lastCommand: line });
        } catch (e) {
          print('shell error: ' + e.message, 'err');
        }
      }

      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          const v = input.value;
          input.value = '';
          exec(v);
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          if (hp > 0) { hp--; input.value = hist[hp] || ''; }
        } else if (e.key === 'ArrowDown') {
          e.preventDefault();
          if (hp < hist.length - 1) { hp++; input.value = hist[hp] || ''; } else { hp = hist.length; input.value = ''; }
        } else if (e.key === 'l' && e.ctrlKey) {
          e.preventDefault(); out.innerHTML = '';
        }
      });
      setTimeout(() => input.focus(), 200);

      if (a.args && a.args.cmd) setTimeout(() => exec(a.args.cmd), 300);

      return {
        handleCommand(cmd) {
          const args = cmd.args || {};
          const op = String(cmd.op || '').toLowerCase();
          if (op === 'shell' || op === 'run' || op === 'exec') {
            const c = args.cmd || args.command || args.text;
            if (!c) return { ok: false, error: 'args.cmd required' };
            return new Promise(async (resolve) => {
              const r = await WebOS.api.shell(c, args.cwd || cwd);
              if (r.cwd) { cwd = r.cwd; setPs1(); }
              printf('<span class="cmd">agent@webos:' + esc(cwd) + '$</span> ' + esc(c));
              if (r.out && r.out !== '__CLEAR__') print(r.out, r.code === 0 ? '' : 'err');
              a.publishState({ cwd, lastCommand: c });
              resolve({ ok: r.code === 0, out: r.out, code: r.code, cwd: r.cwd });
            });
          }
          if (op === 'focusinput') { input.focus(); return { ok: true }; }
          return null;
        },
        state() { return { cwd, sessionId, history: hist.slice(-10) }; }
      };
    }
  });
})();
