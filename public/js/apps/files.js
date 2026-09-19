/* ============ Files — virtual filesystem browser ============ */
(function () {
  'use strict';
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function mk(t, c, h) { const n = document.createElement(t); if (c) n.className = c; if (h != null) n.innerHTML = h; return n; }
  const icon = (e) => e.type === 'dir' ? '📁' : /\.(md|txt|log|json|js|css|html)$/i.test(e.name) ? '📄' : '📃';
  const fmt = (b) => b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(1) + ' KB' : (b / 1048576).toFixed(1) + ' MB';

  WebOS.registerApp({
    id: 'files', name: 'Files', icon: '📁', width: 900, height: 560,
    mount(a) {
      let cwd = (a.args && (a.args.path || a.args.arg)) || '/Home';
      let sel = null;

      const root = a.win.body;
      const toolbar = mk('div', 'toolbar');
      toolbar.innerHTML = `
        <button class="tb-btn" data-a="up" title="Up">⬆</button>
        <button class="tb-btn" data-a="refresh" title="Refresh">⟳</button>
        <input class="inp mono" id="pathin" spellcheck="false">
        <button class="tb-btn" data-a="newdir">＋ Folder</button>
        <button class="tb-btn" data-a="newfile">＋ File</button>
        <button class="tb-btn" data-a="rename" disabled>✏️</button>
        <button class="tb-btn" data-a="delete" disabled>🗑</button>
        <button class="tb-btn" data-a="download" disabled>⤓</button>`;
      const split = mk('div', 'split');
      const side = mk('div', 'side');
      const list = mk('div', 'list');
      split.appendChild(side); split.appendChild(list);
      const status = mk('div', 'statusbar');
      root.appendChild(toolbar); root.appendChild(split); root.appendChild(status);

      const pathin = toolbar.querySelector('#pathin');
      pathin.addEventListener('keydown', (e) => { if (e.key === 'Enter') { cwd = pathin.value.trim() || cwd; refresh(); } });

      toolbar.addEventListener('click', async (e) => {
        const act = e.target.dataset && e.target.dataset.a;
        if (!act) return;
        if (act === 'up') { cwd = cwd.replace(/\/[^/]+\/?$/, '') || '/'; refresh(); }
        if (act === 'refresh') refresh();
        if (act === 'newdir') {
          const name = await WebOS.prompt('New folder name', '', 'e.g. Projects');
          if (name) { await WebOS.api.fs.mkdir(cwd.replace(/\/$/, '') + '/' + name); refresh(); }
        }
        if (act === 'newfile') {
          const name = await WebOS.prompt('New file name', 'untitled.txt', 'notes.txt');
          if (name) { await WebOS.api.fs.write(cwd.replace(/\/$/, '') + '/' + name, ''); refresh(); }
        }
        if (act === 'rename' && sel) {
          const name = await WebOS.prompt('Rename "' + sel.name + '"', sel.name);
          if (name && name !== sel.name) { await WebOS.api.fs.move(join(cwd, sel.name), join(cwd, name)); sel = null; refresh(); }
        }
        if (act === 'delete' && sel) {
          const ok = await WebOS.confirm('Delete "' + sel.name + '"?');
          if (ok) { await WebOS.api.fs.rm(join(cwd, sel.name), true); sel = null; refresh(); }
        }
        if (act === 'download' && sel && sel.type === 'file') {
          const r = await WebOS.api.fs.read(join(cwd, sel.name));
          const blob = new Blob([r.content || ''], { type: 'text/plain' });
          const url = URL.createObjectURL(blob);
          const link = document.createElement('a');
          link.href = url; link.download = sel.name; link.click();
          setTimeout(() => URL.revokeObjectURL(url), 4000);
        }
      });

      function join(base, name) { return (base.replace(/\/$/, '') || '') + '/' + name; }
      function setSel(entry) {
        sel = entry;
        toolbar.querySelector('[data-a="rename"]').disabled = !sel;
        toolbar.querySelector('[data-a="delete"]').disabled = !sel;
        toolbar.querySelector('[data-a="download"]').disabled = !(sel && sel.type === 'file');
        Array.from(list.children).forEach(r => r.classList.toggle('sel', sel && r.dataset.name === sel.name));
      }

      async function refresh() {
        const r = await WebOS.api.fs.list(cwd);
        if (r.error) { list.innerHTML = `<div class="empty"><span class="big">⚠️</span>${esc(r.error)}</div>`; return; }
        cwd = r.path || cwd;
        pathin.value = cwd;
        a.setTitle('Files', cwd);
        list.innerHTML = '';
        if (!r.entries.length) list.innerHTML = '<div class="empty"><span class="big">📂</span>Ye folder khaali hai</div>';
        r.entries.forEach(entry => {
          const row = mk('div', 'row');
          row.dataset.name = entry.name;
          row.dataset.type = entry.type;
          row.innerHTML = `<span class="ic">${icon(entry)}</span><span>${esc(entry.name)}</span>
            <span class="meta">${entry.type === 'dir' ? entry.size + ' items' : fmt(entry.size)} · ${new Date(entry.modified).toLocaleDateString()}</span>`;
          row.onclick = () => setSel(entry);
          row.ondblclick = () => {
            if (entry.type === 'dir') { cwd = join(cwd, entry.name); sel = null; refresh(); }
            else WebOS.open('editor', { path: join(cwd, entry.name) });
          };
          list.appendChild(row);
        });
        const st = await WebOS.api.get('/api/fs/stats');
        status.innerHTML = `<span>${r.entries.length} items</span><span>disk: ${fmt(st.bytes || 0)} in ${st.files || 0} files</span><span>${esc(cwd)}</span>`;
        a.publishState({ cwd, entries: r.entries.map(x => ({ name: x.name, type: x.type, size: x.size })) });
      }

      async function buildSide() {
        const r = await WebOS.api.fs.list('/');
        side.innerHTML = '';
        const places = [['🏠 Home', '/Home'], ['📄 Documents', '/Home/Documents'], ['⬇ Downloads', '/Home/Downloads'], ['🛠 Projects', '/Home/Projects'], ['🖼 Pictures', '/Home/Pictures'], ['💿 / (root)', '/']];
        if (r.entries) r.entries.forEach(e => { if (e.type === 'dir' && !places.some(p => p[1] === '/' + e.name)) places.push(['📁 ' + e.name, '/' + e.name]); });
        places.forEach(([label, p]) => {
          const i = mk('div', 'item', label);
          i.dataset.path = p;
          i.onclick = () => { cwd = p; setSel(null); refresh(); };
          side.appendChild(i);
        });
      }

      buildSide(); refresh();
      return {
        handleCommand(cmd) {
          const args = cmd.args || {};
          const op = String(cmd.op || '').toLowerCase();
          if (op === 'list' || op === 'ls') {
            if (args.path) cwd = args.path;
            refresh();
            return { ok: true, path: cwd };
          }
          if (op === 'cd' || op === 'openpath') {
            if (!args.path) return { ok: false, error: 'args.path required' };
            cwd = args.path; sel = null; refresh();
            return { ok: true, path: cwd };
          }
          if (op === 'select') {
            const row = Array.from(list.children).find(r => r.dataset.name === (args.name || args.text));
            if (!row) return { ok: false, error: 'entry not found: ' + args.name };
            row.click();
            return { ok: true, selected: args.name };
          }
          if (op === 'openitem' || op === 'dblclick') {
            const row = Array.from(list.children).find(r => r.dataset.name === (args.name || args.text));
            if (!row) return { ok: false, error: 'entry not found' };
            row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
            return { ok: true, opened: args.name };
          }
          return null;
        },
        state() { return { cwd, selected: sel && sel.name }; }
      };
    }
  });
})();
